import express from 'express';
import type { Request, Response, RequestHandler, NextFunction } from 'express';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import { logger } from './logger.js';
import { getActiveIssues, getWorkLogs, getPlanning, jiraClient, getIssuesForProject, getWorkLogsForProject, getIssues } from './jira.js';
import cors from 'cors';
import type { WorkLogsResponse } from './types.js';
import { JIRA_DOMAIN } from './config.js';
import axios from 'axios';
import { getProjectConfigsFromSheet, getWorklogConfigsFromSheet } from './google-sheets.js';
import { getGoogleSheetsData } from './google-sheets.js';
import { 
    Issue, 
    WorkLog, 
    EmployeeResult, 
    SprintResult, 
    WorklogConfig,
    EfficiencyData,
    JiraIssue
} from './types.js';

type GoogleSheetsData = (string | null)[][];

interface SprintCapacity {
    employee: string;
    sprint: string;
    capacity: number;
    project: string;
}

interface PlanningResult {
    sprintCapacity: SprintCapacity[];
    employeeSprintUsedHours: {
        employee: string;
        sprintHours: {
            sprint: string;
            hours: number;
            issues: { key: string; hours: number }[];
        }[];
    }[];
    plannedIssues: {
        issue: JiraIssue;
        sprint: string;
        hours: number;
    }[];
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Laad .env.local bestand
config({ path: join(__dirname, '../.env.local') });

// Controleer of alle benodigde environment variables aanwezig zijn
const requiredEnvVars = [
    'JIRA_HOST',
    'JIRA_USERNAME',
    'JIRA_API_TOKEN',
    'GOOGLE_SHEETS_CLIENT_EMAIL',
    'GOOGLE_SHEETS_PRIVATE_KEY',
    'GOOGLE_SHEETS_SPREADSHEET_ID'
];

for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        console.error(`Ontbrekende environment variable: ${envVar}`);
        process.exit(1);
    }
}

const app = express();
const port = process.env.PORT || 3001;

if (!process.env.GOOGLE_SHEETS_SPREADSHEET_ID) {
    throw new Error('Missing GOOGLE_SHEETS_SPREADSHEET_ID in environment variables');
}

if (!process.env.GOOGLE_SHEETS_CLIENT_EMAIL) {
    throw new Error('Missing GOOGLE_SHEETS_CLIENT_EMAIL in environment variables');
}

if (!process.env.GOOGLE_SHEETS_PRIVATE_KEY) {
    throw new Error('Missing GOOGLE_SHEETS_PRIVATE_KEY in environment variables');
}

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

// Google Sheets configuratie
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
const auth = new JWT({
    email: process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
    key: process.env.GOOGLE_SHEETS_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: SCOPES
});

const sheets = google.sheets({ version: 'v4', auth });

app.use(cors());
app.use(express.json());

// Basis route
app.get('/', async (req, res) => {
    try {
        // Haal project configuraties op
        const projectConfigs = await getProjectConfigsFromSheet();
        logger.log(`Beschikbare projecten: ${projectConfigs.map(p => p.projectName).join(', ')}`);
        
        // Haal Google Sheets data op
        const googleSheetsData = await getGoogleSheetsData();
        
        // Verwerk elk project
        let html = `
            <!DOCTYPE html>
            <html lang="nl">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Planning Overzicht</title>
                <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/css/bootstrap.min.css" rel="stylesheet">
                <style>
                    ${styles}
                    .table { font-size: 0.9rem; }
                    .table th { background-color: #f8f9fa; }
                    .table-success { background-color: #d4edda !important; }
                    .table-warning { background-color: #fff3cd !important; }
                    .table-danger { background-color: #f8d7da !important; }
                    .btn-group { margin-bottom: 20px; }
                    .navbar { margin-bottom: 20px; }
                </style>
            </head>
            <body>
                <nav class="navbar">
                    <a href="/" class="navbar-brand">Planning Dashboard</a>
                    <ul class="navbar-nav">
                        <li class="nav-item">
                            <a href="/" class="nav-link active">Planning</a>
                        </li>
                        <li class="nav-item">
                            <a href="/worklogs" class="nav-link">Worklogs & Efficiëntie</a>
                        </li>
                    </ul>
                </nav>
                <div class="container-fluid">
        `;

        // Verwerk elk project
        for (const projectConfig of projectConfigs) {
            const issues = await getIssues(projectConfig.jqlFilter);
            const jiraIssues = convertIssuesToJiraIssues(issues);
            const planning = await calculatePlanning(jiraIssues, projectConfig.projectName, googleSheetsData);
            const sprintNames = await getSprintNamesFromSheet(googleSheetsData);
            
            html += generatePlanningTable(planning, sprintNames);
        }

        html += `
                </div>
                <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/js/bootstrap.bundle.min.js"></script>
            </body>
            </html>
        `;

        res.send(html);
    } catch (error) {
        console.error('Error in / route:', error);
        res.status(500).send('Er is een fout opgetreden bij het ophalen van de planning');
    }
});

// Configureer axios interceptors voor error handling
jiraClient.interceptors.response.use(
    response => response,
    error => {
        console.error('Jira API Error:', error.response?.data || error.message);
        return Promise.reject(new Error(error.response?.data?.errorMessages?.[0] || error.message));
    }
);

app.get('/progress', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    // Stuur een event wanneer de verbinding tot stand is gekomen
    res.write('data: {"step": 0}\n\n');
});

function calculateExpectedHours(startDate: string, endDate: string, availableHoursPerWeek: number, employeeName: string): number {
    const start = new Date(startDate);
    const end = new Date(endDate);
    let totalDays = 0;
    let currentDate = new Date(start);

    // Tel alleen weekdagen (maandag t/m vrijdag)
    while (currentDate <= end) {
        const dayOfWeek = currentDate.getDay();
        // Alleen maandag (1) t/m vrijdag (5) tellen mee
        if (dayOfWeek >= 1 && dayOfWeek <= 5) {
            totalDays++;
        }
        currentDate.setDate(currentDate.getDate() + 1);
    }

    // Bereken beschikbare uren per dag door de beschikbare uren per week te delen door 5
    const availableHoursPerDay = availableHoursPerWeek / 5;
    
    // Bereken verwachte uren door beschikbare uren per dag te vermenigvuldigen met aantal dagen
    const expectedHours = Number((totalDays * availableHoursPerDay).toFixed(1));

    return expectedHours;
}

interface IssueHistory {
    created: string;
    items: {
        field: string;
        toString: string;
    }[];
}

async function calculateEfficiency(issues: JiraIssue[], worklogs: WorkLog[], startDate: Date, endDate: Date): Promise<EfficiencyData[]> {
    logger.log('Start calculateEfficiency functie');
    
    // Haal project configuraties op uit Google Sheet
    const projectConfigs = await getProjectConfigsFromSheet();
    
    // Verzamel alle unieke projectcodes
    const projectCodes = new Set<string>();
    projectConfigs.forEach(config => {
        if (config.projectCodes && Array.isArray(config.projectCodes)) {
            config.projectCodes.forEach(code => {
                if (typeof code === 'string') {
                    projectCodes.add(code.trim());
                }
            });
        }
    });
    
    // Debug logging voor projectcodes
    logger.log('Projectcodes voor efficiëntie berekening:');
    logger.log(Array.from(projectCodes).join(', '));
    
    // Bouw de JQL query met projectcodes
    const projectFilter = Array.from(projectCodes).map(code => `project = ${code}`).join(' OR ');
    
    // Debug logging voor projectFilter
    logger.log('Project filter voor efficiëntie berekening:');
    logger.log(projectFilter);
    
    const jql = `(${projectFilter}) AND resolutiondate >= "${startDate.toISOString().split('T')[0]}" AND resolutiondate <= "${endDate.toISOString().split('T')[0]}" AND status = Closed ORDER BY resolutiondate DESC`;
    
    // Debug logging voor uiteindelijke JQL
    logger.log('Uiteindelijke JQL query voor efficiëntie berekening:');
    logger.log(jql);
    
    logger.log(`JQL Query voor efficiency berekening: ${jql}`);
    const allClosedIssues = await getIssues(jql);
    
    logger.log(`Aantal afgesloten issues van alle projecten: ${allClosedIssues.length}`);
    logger.log(`Aantal worklogs: ${worklogs.length}`);
    logger.log(`Periode: ${startDate.toISOString()} tot ${endDate.toISOString()}`);

    // Groepeer worklogs per medewerker
    const worklogsByEmployee = new Map<string, WorkLog[]>();
    worklogs.forEach(log => {
        const employeeName = typeof log.author === 'string' ? 
            log.author : 
            (log.author && typeof log.author === 'object' && 'displayName' in log.author ? 
                log.author.displayName : 
                'Onbekend');
        
        if (!worklogsByEmployee.has(employeeName)) {
            worklogsByEmployee.set(employeeName, []);
        }
        worklogsByEmployee.get(employeeName)?.push(log);
    });

    logger.log(`Aantal medewerkers met worklogs: ${worklogsByEmployee.size}`);

    // Bereken efficiëntie per medewerker
    const efficiencyData: EfficiencyData[] = [];
    worklogsByEmployee.forEach((employeeWorklogs, employeeName) => {
        // Filter issues voor deze medewerker
        const employeeIssues = allClosedIssues.filter((issue: any) => 
            issue.fields && issue.fields.assignee && issue.fields.assignee.displayName === employeeName
        );

        // Bereken totale geschatte uren en verzamel issue details
        let totalEstimatedHours = 0;
        const issueDetails: { key: string; estimatedHours: number; loggedHours: number }[] = [];

        employeeIssues.forEach(issue => {
            const issueKey = issue.key;
            
            // Bereken geschatte uren voor dit issue
            const estimatedHours = issue.fields?.timeoriginalestimate 
                ? issue.fields.timeoriginalestimate / 3600 
                : 0;
            totalEstimatedHours += estimatedHours;

            // Bereken gelogde uren voor dit issue binnen de opgegeven periode
            const loggedHours = employeeWorklogs
                .filter(log => {
                    const logDate = new Date(log.started);
                    return log.issueKey === issueKey && 
                           logDate >= startDate && 
                           logDate <= endDate;
                })
                .reduce((total, log) => total + log.timeSpentSeconds / 3600, 0);

            issueDetails.push({
                key: issueKey,
                estimatedHours,
                loggedHours
            });
        });

        // Bereken totale gelogde uren
        const totalLoggedHours = issueDetails.reduce((total, detail) => total + detail.loggedHours, 0);

        // Bereken efficiëntie
        const efficiency = totalEstimatedHours > 0 ? (totalLoggedHours / totalEstimatedHours) * 100 : 0;

        efficiencyData.push({
            employee: employeeName,
            estimatedHours: Number(totalEstimatedHours.toFixed(1)),
            loggedHours: Number(totalLoggedHours.toFixed(1)),
            efficiency: Number(efficiency.toFixed(1)),
            totalHours: 0,
            nonWorkingHours: 0,
            nonIssueHours: 0
        });
    });

    logger.log(`\nEindresultaat efficiëntie berekening:`);
    efficiencyData.forEach((data: EfficiencyData) => {
        // Verwijder de logging van efficiëntie per medewerker
    });

    return efficiencyData;
}

app.get('/worklogs', (req, res) => {
    const html = `
        <!DOCTYPE html>
        <html lang="nl">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Worklogs & Efficiëntie Dashboard</title>
            <style>
                ${styles}
            </style>
        </head>
        <body>
            <nav class="navbar">
                <a href="/" class="navbar-brand">Planning Dashboard</a>
                <ul class="navbar-nav">
                    <li class="nav-item">
                        <a href="/" class="nav-link">Planning</a>
                    </li>
                    <li class="nav-item">
                        <a href="/worklogs" class="nav-link active">Worklogs & Efficiëntie</a>
                    </li>
                </ul>
            </nav>
            <div class="container">
                <div class="card mb-4">
                    <div class="card-header">
                        <h2 class="mb-0">Worklogs & Efficiëntie</h2>
                    </div>
                    <div class="card-body">
                        <div class="worklogs-form">
                            <div class="row">
                                <div class="col-md-4">
                                    <label for="startDate" class="form-label">Startdatum</label>
                                    <input type="date" class="form-control" id="startDate" name="startDate">
                                </div>
                                <div class="col-md-4">
                                    <label for="endDate" class="form-label">Einddatum</label>
                                    <input type="date" class="form-control" id="endDate" name="endDate">
                                </div>
                                <div class="col-md-4">
                                    <label class="form-label">&nbsp;</label>
                                    <button type="button" class="btn btn-primary" onclick="loadWorklogs()">Laad Worklogs</button>
                                </div>
                            </div>
                        </div>
                        <div id="worklogsContainer">
                            <div class="alert alert-info">
                                Selecteer een begin- en einddatum om de worklogs te bekijken.
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <script>
                async function loadWorklogs() {
                    const startDate = document.getElementById('startDate').value;
                    const endDate = document.getElementById('endDate').value;
                    
                    if (!startDate || !endDate) {
                        alert('Selecteer een begin- en einddatum');
                        return;
                    }

                    try {
                        const response = await fetch(\`/api/worklogs?startDate=\${startDate}&endDate=\${endDate}\`);
                        if (!response.ok) {
                            throw new Error('Er is een fout opgetreden bij het ophalen van de worklogs.');
                        }
                        const html = await response.text();
                        document.getElementById('worklogsContainer').innerHTML = html;
                    } catch (error) {
                        document.getElementById('worklogsContainer').innerHTML = \`
                            <div class="alert alert-danger">
                                Er is een fout opgetreden bij het ophalen van de worklogs.
                            </div>
                        \`;
                    }
                }
            </script>
        </body>
        </html>
    `;
    res.send(html);
});

// Functie om de Worklogs totaal tabel te genereren op basis van de verzamelde data
function generateTotalWorklogsTableFromData(totalHoursByEmployeeAndCategory: Map<string, Map<string, number>>): string {
    // Bepaal de categorieën (kolommen) voor de tabel
    const categories = Array.from(totalHoursByEmployeeAndCategory.values())
        .reduce((allCategories, employeeCategories) => {
            employeeCategories.forEach((_, category) => allCategories.add(category));
            return allCategories;
        }, new Set<string>());
    
    let html = `
        <div class="row">
            <div class="col-md-12">
                <h4>Worklogs Totaal</h4>
                <table class="table table-striped">
                    <thead>
                        <tr>
                            <th>Medewerker</th>
                            ${Array.from(categories).map(category => `<th>${category}</th>`).join('')}
                            <th>Totaal</th>
                        </tr>
                    </thead>
                    <tbody>
    `;
    
    // Bereken totalen per categorie
    const categoryTotals = new Map<string, number>();
    categories.forEach(category => {
        categoryTotals.set(category, 0);
    });
    
    // Genereer rijen voor elke medewerker
    totalHoursByEmployeeAndCategory.forEach((employeeCategories, employee) => {
        let employeeTotal = 0;
        html += `<tr><td>${employee}</td>`;
        
        Array.from(categories).forEach(category => {
            const hours = employeeCategories.get(category) || 0;
            employeeTotal += hours;
            categoryTotals.set(category, (categoryTotals.get(category) || 0) + hours);
            html += `<td>${hours.toFixed(1)}</td>`;
        });
        
        html += `<td>${employeeTotal.toFixed(1)}</td></tr>`;
    });
    
    // Bereken totaal van alle categorieën
    const grandTotal = Array.from(categoryTotals.values()).reduce((sum, total) => sum + total, 0);
    
    // Voeg totaalregel toe
    html += `
        <tr class="table-dark">
            <td><strong>Totaal</strong></td>
            ${Array.from(categories).map(category => 
                `<td><strong>${categoryTotals.get(category)?.toFixed(1) || '0.0'}</strong></td>`
            ).join('')}
            <td><strong>${grandTotal.toFixed(1)}</strong></td>
        </tr>
    `;
    
    html += '</tbody></table></div></div>';
    return html;
}

// Error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error(`Server error: ${err}`);
    res.status(500).send(`
        <div class="alert alert-danger">
            Er is een interne serverfout opgetreden: ${err.message || err}
        </div>
    `);
});

// Unhandled promise rejection handler
process.on('unhandledRejection', (reason: unknown) => {
    console.error('Unhandled Rejection:', reason);
    if (reason instanceof Error) {
        console.error('Stack trace:', reason.stack);
    }
});

// Uncaught exception handler
process.on('uncaughtException', (error: Error) => {
    console.error('Unhandled Exception:', error.message);
    console.error('Stack trace:', error.stack);
    process.exit(1);
});

// Start de server in een try-catch block
try {
    app.listen(port, () => {
        console.log(`Server draait op poort ${port}`);
    }).on('error', (error) => {
        console.error(`Error bij starten van server: ${error}`);
        process.exit(1);
    });
} catch (error) {
    console.error(`Error bij starten van server: ${error}`);
    process.exit(1);
}

// Styles voor de pagina
const styles = `
    body { 
        font-family: Arial, sans-serif; 
        margin: 0;
        padding: 0;
        background-color: #f5f5f5;
    }
    .container {
        max-width: 1400px;
        margin: 0 auto;
        padding: 20px;
        background-color: white;
        box-shadow: 0 0 10px rgba(0,0,0,0.1);
        border-radius: 5px;
    }
    h1, h2, h3 {
        color: #333;
        margin-top: 20px;
        margin-bottom: 15px;
        border-bottom: 1px solid #ddd;
        padding-bottom: 10px;
    }
    table { 
        border-collapse: collapse; 
        width: 100%; 
        margin-bottom: 30px; 
        background-color: white;
        box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    th, td { 
        border: 1px solid #ddd; 
        padding: 12px 15px; 
        text-align: left; 
    }
    th { 
        background-color: #f2f2f2; 
        font-weight: bold;
        color: #333;
    }
    tr:nth-child(even) {
        background-color: #f9f9f9;
    }
    tr:hover {
        background-color: #f1f1f1;
    }
    .table-dark {
        background-color: #f2f2f2;
        font-weight: bold;
        color: #333;
    }
    .table-dark th {
        color: #333;
    }
    .table-info {
        background-color: #e6f7ff;
    }
    .card { 
        margin-bottom: 30px; 
        border: 1px solid #ddd;
        border-radius: 5px;
        overflow: hidden;
    }
    .card-header { 
        background-color: #f8f9fa; 
        padding: 15px 20px;
        border-bottom: 1px solid #ddd;
    }
    .card-body { 
        padding: 20px; 
    }
    .row {
        display: flex;
        flex-wrap: wrap;
        margin-right: -15px;
        margin-left: -15px;
    }
    .col-12 {
        flex: 0 0 100%;
        max-width: 100%;
        padding: 0 15px;
    }
    .col-md-6 {
        flex: 0 0 50%;
        max-width: 50%;
        padding: 0 15px;
    }
    .col-md-4 {
        flex: 0 0 33.333333%;
        max-width: 33.333333%;
        padding: 0 15px;
    }
    @media (max-width: 768px) {
        .col-md-6, .col-md-4 {
            flex: 0 0 100%;
            max-width: 100%;
        }
    }
    .mt-4 {
        margin-top: 1.5rem;
    }
    .form-label { 
        margin-bottom: 5px; 
        font-weight: bold;
    }
    .form-control { 
        margin-bottom: 15px; 
        padding: 8px 12px;
        border: 1px solid #ddd;
        border-radius: 4px;
        width: 100%;
    }
    .btn-primary { 
        margin-top: 24px; 
        background-color: #007bff;
        color: white;
        border: none;
        padding: 10px 15px;
        border-radius: 4px;
        cursor: pointer;
    }
    .btn-primary:hover {
        background-color: #0069d9;
    }
    .alert { 
        margin-bottom: 15px; 
        padding: 15px;
        border-radius: 4px;
    }
    .alert-danger {
        background-color: #f8d7da;
        color: #721c24;
        border: 1px solid #f5c6cb;
    }
    .alert-info {
        background-color: #d1ecf1;
        color: #0c5460;
        border: 1px solid #bee5eb;
    }
    .date-input { 
        width: 100%; 
        padding: 8px 12px; 
        border: 1px solid #ddd; 
        border-radius: 4px; 
    }
    .worklogs-form { 
        margin-bottom: 20px; 
        background-color: #f9f9f9;
        padding: 20px;
        border-radius: 5px;
    }
    .worklogs-form .row {
        display: flex;
        flex-wrap: wrap;
        margin-right: -15px;
        margin-left: -15px;
    }
    .worklogs-form .col-md-4 {
        flex: 0 0 33.333333%;
        max-width: 33.333333%;
        padding: 0 15px;
        margin-bottom: 15px;
    }
    .worklogs-form .form-label { 
        margin-bottom: 5px; 
        font-weight: bold;
        display: block;
    }
    .worklogs-form .form-control { 
        margin-bottom: 15px; 
        padding: 8px 12px;
        border: 1px solid #ddd;
        border-radius: 4px;
        width: 100%;
        box-sizing: border-box;
    }
    .worklogs-form .btn-primary { 
        margin-top: 0; 
        background-color: #007bff;
        color: white;
        border: none;
        padding: 10px 15px;
        border-radius: 4px;
        cursor: pointer;
        width: 100%;
        height: 38px;
    }
    .worklogs-form .btn-primary:hover {
        background-color: #0069d9;
    }
    a {
        color: #007bff;
        text-decoration: none;
    }
    a:hover {
        text-decoration: underline;
    }
    .nav-tabs {
        display: flex;
        border-bottom: 1px solid #ddd;
        margin-bottom: 20px;
    }
    .nav-tabs .nav-item {
        margin-bottom: -1px;
    }
    .nav-tabs .nav-link {
        display: block;
        padding: 10px 15px;
        border: 1px solid transparent;
        border-top-left-radius: 4px;
        border-top-right-radius: 4px;
        color: #495057;
        background-color: #f8f9fa;
        margin-right: 5px;
    }
    .nav-tabs .nav-link.active {
        color: #495057;
        background-color: #fff;
        border-color: #ddd #ddd #fff;
        font-weight: bold;
    }
    .tab-content {
        padding: 20px 0;
    }
    .tab-pane {
        display: none;
    }
    .tab-pane.active {
        display: block;
    }
    .navbar {
        background-color: #333;
        padding: 15px 20px;
        margin-bottom: 20px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        position: sticky;
        top: 0;
        z-index: 1000;
    }
    .navbar-brand {
        color: white;
        font-size: 1.5rem;
        font-weight: bold;
        text-decoration: none;
        padding: 10px 0;
    }
    .navbar-nav {
        display: flex;
        list-style: none;
        margin: 0;
        padding: 0;
        gap: 20px;
    }
    .nav-item {
        margin: 0;
    }
    .nav-link {
        color: #ddd;
        text-decoration: none;
        padding: 8px 16px;
        border-radius: 4px;
        transition: all 0.3s ease;
    }
    .nav-link:hover {
        color: white;
        background-color: rgba(255,255,255,0.1);
    }
    .nav-link.active {
        color: white;
        background-color: rgba(255,255,255,0.2);
        font-weight: bold;
    }
    .container-fluid {
        padding: 20px;
        margin-top: 20px;
    }
`;

function generatePlanningTable(planning: PlanningResult, sprintNames: Map<string, string>): string {
    return `
        <div class="row mb-4">
            <div class="col">
                <div class="d-flex justify-content-between align-items-center">
                    <h2 class="mb-0">Planning</h2>
                    <div class="btn-group">
                        <a href="/worklogs" class="btn btn-outline-primary">Worklogs</a>
                        <a href="/planning" class="btn btn-primary">Planning</a>
                    </div>
                </div>
            </div>
        </div>
        <div class="row">
            <div class="col">
                <div class="table-responsive">
                    <table class="table table-striped table-bordered">
                        <thead>
                            <tr class="table-dark text-dark">
                                <th>Sprint</th>
                                <th>Medewerker</th>
                                <th>Capaciteit</th>
                                <th>Gebruikt</th>
                                <th>Beschikbaar</th>
                                <th>Geplande Issues</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${planning.sprintCapacity.map(capacity => {
                                const sprintName = sprintNames.get(capacity.sprint) || capacity.sprint;
                                const employeePlanning = planning.employeeSprintUsedHours.find(
                                    esp => esp.employee === capacity.employee
                                );
                                const sprintHours = employeePlanning?.sprintHours.find(
                                    sh => sh.sprint === capacity.sprint
                                );
                                const usedHours = sprintHours?.hours || 0;
                                const availableHours = capacity.capacity - usedHours;
                                const plannedIssues = sprintHours?.issues || [];
                                
                                return `
                                    <tr>
                                        <td>${sprintName}</td>
                                        <td>${capacity.employee}</td>
                                        <td>${capacity.capacity}</td>
                                        <td>${usedHours}</td>
                                        <td>${availableHours}</td>
                                        <td>${plannedIssues.map(issue => 
                                            `${issue.key} (${issue.hours} uur)`
                                        ).join('<br>')}</td>
                                    </tr>
                                `;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    `;
}

app.get('/planning', async (req, res) => {
    try {
        const projectType = req.query.project as string;
        if (!projectType) {
            return res.status(400).send('Project type is verplicht');
        }

        // Haal project configuraties op
        const projectConfigs = await getProjectConfigsFromSheet();
        logger.log(`Beschikbare projecten: ${projectConfigs.map(p => p.projectName).join(', ')}`);
        
        const projectConfig = projectConfigs.find(config => config.projectName === projectType);
        if (!projectConfig) {
            logger.error(`Project configuratie niet gevonden voor: ${projectType}`);
            return res.status(404).send('Project configuratie niet gevonden');
        }

        logger.log(`Project configuratie gevonden: ${JSON.stringify(projectConfig)}`);

        // Haal Google Sheets data op
        let googleSheetsData;
        try {
            googleSheetsData = await getGoogleSheetsData();
        } catch (error) {
            console.error('Error bij ophalen van Google Sheets data:', error);
            throw error;
        }

        const issues = await getIssues(projectConfig.jqlFilter);
        const jiraIssues = convertIssuesToJiraIssues(issues);
        const planning = await calculatePlanning(jiraIssues, projectType, googleSheetsData);
        const sprintNames = await getSprintNamesFromSheet(googleSheetsData);

        let html = `
            <!DOCTYPE html>
            <html lang="nl">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Planning Overzicht - ${projectType}</title>
                <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/css/bootstrap.min.css" rel="stylesheet">
                <style>
                    ${styles}
                    .table { font-size: 0.9rem; }
                    .table th { background-color: #f8f9fa; }
                    .table-success { background-color: #d4edda !important; }
                    .table-warning { background-color: #fff3cd !important; }
                    .table-danger { background-color: #f8d7da !important; }
                    .btn-group { margin-bottom: 20px; }
                    .navbar { margin-bottom: 20px; }
                </style>
            </head>
            <body>
                <nav class="navbar">
                    <a href="/" class="navbar-brand">Planning Dashboard</a>
                    <ul class="navbar-nav">
                        <li class="nav-item">
                            <a href="/" class="nav-link active">Planning</a>
                        </li>
                        <li class="nav-item">
                            <a href="/worklogs" class="nav-link">Worklogs & Efficiëntie</a>
                        </li>
                    </ul>
                </nav>
                <div class="container-fluid">
                    ${generatePlanningTable(planning, sprintNames)}
                </div>
                <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/js/bootstrap.bundle.min.js"></script>
            </body>
            </html>
        `;

        res.send(html);
    } catch (error) {
        console.error('Error in /planning route:', error);
        res.status(500).send('Er is een fout opgetreden bij het ophalen van de planning');
    }
});

async function getSprintNamesFromSheet(googleSheetsData: (string | null)[][] | null): Promise<Map<string, string>> {
    const sprintNames = new Map<string, string>();
    
    if (!googleSheetsData) {
        return sprintNames;
    }

    // Zoek de kolom met sprint namen
    const headerRow = googleSheetsData[0];
    const sprintNameColIndex = headerRow.findIndex(header => header === 'Sprint');
    
    if (sprintNameColIndex === -1) {
        return sprintNames;
    }

    // Vul de map met sprint nummers en namen
    for (let i = 1; i < googleSheetsData.length; i++) {
        const row = googleSheetsData[i];
        const sprintNumber = row[0];
        const sprintName = row[sprintNameColIndex];
        
        if (sprintNumber && sprintName) {
            sprintNames.set(sprintNumber.toString(), sprintName.toString());
        }
    }

    return sprintNames;
}

function generateTotalWorklogsTable(worklogs: WorkLog[]): string {
    // Groepeer worklogs per medewerker
    const worklogsByEmployee = new Map<string, WorkLog[]>();
    worklogs.forEach(log => {
        const employeeName = typeof log.author === 'string' ? 
            log.author : 
            (log.author && typeof log.author === 'object' && 'displayName' in log.author ? 
                log.author.displayName : 
                'Onbekend');
        
        if (!worklogsByEmployee.has(employeeName)) {
            worklogsByEmployee.set(employeeName, []);
        }
        worklogsByEmployee.get(employeeName)?.push(log);
    });

    let html = `
        <div class="row">
            <div class="col-md-12">
                <h4>Worklogs Totaal</h4>
                <table class="table table-striped">
                    <thead>
                        <tr>
                            <th>Medewerker</th>
                            <th>Niet gewerkt</th>
                            <th>Overige niet-declarabel</th>
                            <th>Productontwikkeling</th>
                            <th>Totaal</th>
                        </tr>
                    </thead>
                    <tbody>
    `;

    let totalNotWorked = 0;
    let totalNonBillable = 0;
    let totalProductDev = 0;

    worklogsByEmployee.forEach((logs, employee) => {
        // Bereken de uren per categorie op basis van de issues
        const notWorked = logs
            .filter(log => {
                // Filter op basis van de issue key of andere eigenschappen
                // Hier moeten we de juiste logica toevoegen om te bepalen welke issues bij "Niet gewerkt" horen
                return false; // Placeholder - vervang dit met de juiste logica
            })
            .reduce((sum, log) => sum + log.timeSpentSeconds / 3600, 0);
        
        const nonBillable = logs
            .filter(log => {
                // Filter op basis van de issue key of andere eigenschappen
                // Hier moeten we de juiste logica toevoegen om te bepalen welke issues bij "Overige niet-declarabel" horen
                return false; // Placeholder - vervang dit met de juiste logica
            })
            .reduce((sum, log) => sum + log.timeSpentSeconds / 3600, 0);
        
        const productDev = logs
            .filter(log => {
                // Filter op basis van de issue key of andere eigenschappen
                // Hier moeten we de juiste logica toevoegen om te bepalen welke issues bij "Productontwikkeling" horen
                return false; // Placeholder - vervang dit met de juiste logica
            })
            .reduce((sum, log) => sum + log.timeSpentSeconds / 3600, 0);
        
        const total = notWorked + nonBillable + productDev;

        totalNotWorked += notWorked;
        totalNonBillable += nonBillable;
        totalProductDev += productDev;

        html += `
            <tr>
                <td>${employee}</td>
                <td>${notWorked.toFixed(1)}</td>
                <td>${nonBillable.toFixed(1)}</td>
                <td>${productDev.toFixed(1)}</td>
                <td>${total.toFixed(1)}</td>
            </tr>
        `;
    });

    // Voeg totaalregel toe
    const grandTotal = totalNotWorked + totalNonBillable + totalProductDev;
    html += `
        <tr class="table-dark">
            <td><strong>Totaal</strong></td>
            <td><strong>${totalNotWorked.toFixed(1)}</strong></td>
            <td><strong>${totalNonBillable.toFixed(1)}</strong></td>
            <td><strong>${totalProductDev.toFixed(1)}</strong></td>
            <td><strong>${grandTotal.toFixed(1)}</strong></td>
        </tr>
    `;

    html += '</tbody></table></div></div>';
    return html;
}

interface Project {
  key: string;
  name: string;
}

const projects: Project[] = [
  { key: 'PVD', name: 'Planning PvD' },
  { key: 'PVDDEV', name: 'Planning PvD Development' }
];

async function loadWorklogs() {
  try {
    const employees = await getGoogleSheetsData();
    const projectEmployees = employees.map(row => row[0]); // Eerste kolom bevat de medewerkersnamen

    // Haal worklogs op voor alle projecten
    const worklogs = await Promise.all(
      projects.map(async (project: Project) => {
        const projectWorklogs = await getWorkLogsForProject(
          [project.key],
          new Date(),
          new Date(),
          { projectName: project.name, projectCodes: [project.key], jqlFilter: '', worklogName: '', worklogJql: '' }
        );
        return {
          project,
          worklogs: projectWorklogs
        };
      })
    );

    return {
      worklogs,
      projectEmployees
    };
  } catch (error) {
    console.error('Error loading worklogs:', error);
    return {
      worklogs: [],
      projectEmployees: []
    };
  }
}

async function calculatePlanning(issues: JiraIssue[], projectType: string, googleSheetsData: GoogleSheetsData | null): Promise<PlanningResult> {
    // Implementatie van calculatePlanning
    return {
        sprintCapacity: [],
        employeeSprintUsedHours: [],
        plannedIssues: []
    };
}

app.get('/api/worklogs', async (req: Request, res: Response) => {
    try {
        const { startDate, endDate } = req.query;
        
        if (!startDate || !endDate) {
            return res.status(400).json({ error: 'Start- en einddatum zijn verplicht' });
        }

        // Valideer en parseer de datums
        const parsedStartDate = new Date(startDate.toString());
        const parsedEndDate = new Date(endDate.toString());

        // Valideer dat de datums geldig zijn
        if (isNaN(parsedStartDate.getTime())) {
            return res.status(400).json({ error: 'Ongeldige startdatum' });
        }
        if (isNaN(parsedEndDate.getTime())) {
            return res.status(400).json({ error: 'Ongeldige einddatum' });
        }
        if (parsedStartDate > parsedEndDate) {
            return res.status(400).json({ error: 'Startdatum moet voor einddatum liggen' });
        }

        logger.log('Start ophalen worklog configuraties...');
        // Haal worklog configuraties op
        const worklogConfigs = await getWorklogConfigsFromSheet();
        logger.log(`Aantal worklog configuraties: ${worklogConfigs.length}`);
        
        // Haal project configuraties op
        const projectConfigs = await getProjectConfigsFromSheet();
        logger.log(`Aantal project configuraties: ${projectConfigs.length}`);
        
        // Genereer HTML voor worklogs tabel
        let worklogsHtml = '';
        
        // Groepeer worklog configuraties per worklogName
        const worklogGroups = new Map<string, WorklogConfig[]>();
        worklogConfigs.forEach(config => {
            if (!worklogGroups.has(config.worklogName)) {
                worklogGroups.set(config.worklogName, []);
            }
            worklogGroups.get(config.worklogName)!.push({ ...config, projectName: config.projectName || '' });
        });
        logger.log(`Aantal worklog groepen: ${worklogGroups.size}`);

        // Maak een map om de totale uren per medewerker en categorie bij te houden
        const totalHoursByEmployeeAndCategory = new Map<string, Map<string, number>>();
        const allProjectWorklogs: WorkLog[] = [];
        
        // Definieer periodeFilter één keer
        const periodeFilter = `worklogDate >= "${parsedStartDate.toISOString().split('T')[0]}" AND worklogDate <= "${parsedEndDate.toISOString().split('T')[0]}"`;
        
        // Verwerk de worklog groepen
        for await (const [worklogName, configs] of worklogGroups) {
            logger.log(`Verwerken worklog groep: ${worklogName}`);
            // Zoek alle projecten met deze worklogName
            const matchingProjects = projectConfigs.filter(pc => pc.worklogName === worklogName);
            
            if (matchingProjects.length === 0) {
                logger.error(`Geen project configuraties gevonden voor worklogName: ${worklogName}`);
                continue;
            }

            // Verwerk elk project apart
            for await (const projectConfig of matchingProjects) {
                logger.log(`Verwerken project: ${projectConfig.projectName}`);

                // Maak een map om de totale uren per medewerker en categorie bij te houden
                const projectHoursByEmployeeAndCategory = new Map<string, Map<string, number>>();

                // Verwerk de worklogs per kolom
                for (const config of configs) {
                    logger.log(`\nVerwerken van worklogs voor kolom: ${config.columnName}`);
                    
                    let columnWorklogs: WorkLog[] = [];
                    
                    // Haal actieve medewerkers op uit de Google Sheet
                    const googleSheetsData = await getGoogleSheetsData();
                    
                    // Gebruik de juiste kolom indices
                    const nameIndex = 2; // Kolom C (Naam)
                    const projectIndex = 7; // Kolom H (Project)
                    const effectiveHoursIndex = 6; // Kolom G (Effectieve uren)
                    
                    const activeEmployees = googleSheetsData
                        .slice(1) // Skip header row
                        .filter(row => {
                            const sheetProjectName = (row[projectIndex] || '').toString().trim();
                            const configProjectName = projectConfig.projectName.trim();
                            const matches = sheetProjectName === configProjectName;
                            return matches;
                        })
                        .map(row => row[nameIndex]); // Haal medewerkersnamen op
                    
                     
                    // Bouw de JQL query
                    let jql = '';
                    
                    // Voeg issue filter toe voor kolommen met issues
                    if (config.issues && config.issues.length > 0) {
                        let issueFilter = config.issues[0];
                        // Vervang {projectFilter} en {periodeFilter} in het issuefilter
                        const projectFilter = `project in (${projectConfig.projectCodes.map(code => `"${code}"`).join(', ')})`;
                        issueFilter = issueFilter.replace(/{projectFilter}/g, projectFilter);
                        issueFilter = issueFilter.replace(/{periodeFilter}/g, periodeFilter);
                        jql = issueFilter;
                    }
                    // Voeg worklogJql toe als filter voor kolommen zonder issuefilter
                    else if (projectConfig.worklogJql) {
                        let worklogJql = projectConfig.worklogJql;
                        // Vervang {projectFilter} en {periodeFilter} in het worklogJql
                        const projectFilter = `project in (${projectConfig.projectCodes.map(code => `"${code}"`).join(', ')})`;
                        worklogJql = worklogJql.replace(/{projectFilter}/g, projectFilter);
                        worklogJql = worklogJql.replace(/{periodeFilter}/g, periodeFilter);
                        jql = worklogJql;
                    }
                    
                    logger.log(`\n=== JQL Query voor kolom ===`);
                    logger.log(`Project: ${projectConfig.projectName}`);
                    logger.log(`Kolom: ${config.columnName}`);
                    logger.log(`JQL: ${jql}`);
                    
                    // Haal worklogs op voor deze kolom
                    columnWorklogs = await getWorkLogsForProject(
                        projectConfig.projectCodes,
                        parsedStartDate,
                        parsedEndDate,
                        { ...projectConfig, jqlFilter: jql }
                    );
                    
                    // Log worklogs per issue
                    logger.log(`\nWorklogs voor kolom ${config.columnName}:`);
                    const worklogsByIssue = new Map<string, { author: string; hours: number; started: string }[]>();
                    columnWorklogs.forEach(log => {
                        const authorName = typeof log.author === 'string' ? log.author : log.author.displayName;
                        const hours = log.timeSpentSeconds / 3600;
                        
                        // Controleer of de medewerker actief is voor dit project
                        if (!activeEmployees.includes(authorName)) {
                            logger.log(`- ${authorName} is geen actieve medewerker voor ${projectConfig.projectName}, worklog wordt genegeerd`);
                            return;
                        }
                        
                        if (!worklogsByIssue.has(log.issueKey)) {
                            worklogsByIssue.set(log.issueKey, []);
                        }
                        worklogsByIssue.get(log.issueKey)!.push({ author: authorName, hours, started: log.started });
                    });
                    
                    worklogsByIssue.forEach((logs, issueKey) => {
                        logger.log(`\nIssue: ${issueKey}`);
                        logs.forEach(log => {
                            const logDate = new Date(log.started).toISOString().split('T')[0];
                            logger.log(`- ${log.author}: ${log.hours.toFixed(1)} uur (${logDate})`);
                        });
                    });
                    
                    // Voeg worklogs toe aan alle project worklogs
                    allProjectWorklogs.push(...columnWorklogs);
                    
                    logger.log(`Aantal worklogs voor ${config.columnName}: ${columnWorklogs.length}`);
                    
                    // Filter worklogs op actieve medewerkers
                    const filteredWorklogs = columnWorklogs.filter(log => {
                        const authorName = typeof log.author === 'string' ? log.author : log.author.displayName;
                        return activeEmployees.includes(authorName);
                    });
                    
                    logger.log(`Aantal gefilterde worklogs voor ${config.columnName}: ${filteredWorklogs.length}`);
                    
                    // Verwerk worklogs per medewerker
                    filteredWorklogs.forEach(log => {
                        const authorName = typeof log.author === 'string' ? log.author : log.author.displayName;
                        
                        if (!projectHoursByEmployeeAndCategory.has(authorName)) {
                            projectHoursByEmployeeAndCategory.set(authorName, new Map<string, number>());
                        }
                        
                        const employeeCategories = projectHoursByEmployeeAndCategory.get(authorName)!;
                        const currentHours = employeeCategories.get(config.columnName) || 0;
                        employeeCategories.set(config.columnName, currentHours + (log.timeSpentSeconds / 3600));
                    });
                }
                
                // Eerst alle kolommen met issuefilter verwerken
                const kolommenMetIssuefilter = configs.filter(config => config.issues && config.issues.length > 0);
                logger.log(`\nKolommen met issuefilter: ${kolommenMetIssuefilter.map(c => c.columnName).join(', ')}`);
                
                // Bereken waarden voor kolommen zonder issuefilter
                projectHoursByEmployeeAndCategory.forEach((employeeCategories, employee) => {
                    // Haal alle worklogs op voor deze medewerker (zonder issuefilter)
                    const allWorklogs = allProjectWorklogs.filter(log => {
                        const authorName = typeof log.author === 'string' ? log.author : log.author.displayName;
                        return authorName === employee;
                    });
                    
                    // Bereken totaal aantal uren (alle worklogs)
                    const alleWorklogs = allWorklogs.reduce((sum, log) => sum + (log.timeSpentSeconds / 3600), 0);
                    
                    // Update totaal
                    employeeCategories.set('Totaal', alleWorklogs);
                    
                    // Log de waarden voor kolommen met issuefilter
                    logger.log(`\nWaarden voor ${employee}:`);
                    kolommenMetIssuefilter.forEach(config => {
                        const waarde = employeeCategories.get(config.columnName) || 0;
                        logger.log(`- ${config.columnName}: ${waarde}`);
                    });
                    
                    // Bereken waarden voor kolommen zonder issuefilter
                    configs.forEach(config => {
                        if (!config.issues || config.issues.length === 0) {
                            // Bereken totaal van alle kolommen met issuefilter
                            const totaalIssuefilterKolommen = kolommenMetIssuefilter.reduce((sum, issueConfig) => {
                                return sum + (employeeCategories.get(issueConfig.columnName) || 0);
                            }, 0);
                            
                            // Trek de waarden van kolommen met issuefilter af van alle worklogs
                            const waarde = alleWorklogs - totaalIssuefilterKolommen;
                            
                            // Zet de berekende waarde in de kolom zonder issuefilter
                            employeeCategories.set(config.columnName, waarde);
                            
                            // Log de berekening
                            logger.log(`\nBerekening voor ${employee} - ${config.columnName}:`);
                            logger.log(`- Alle worklogs: ${alleWorklogs}`);
                            logger.log(`- Totaal kolommen met issuefilter: ${totaalIssuefilterKolommen}`);
                            logger.log(`- Berekende waarde: ${waarde}`);
                        }
                    });
                });

                // Genereer de worklogs tabel voor dit project
                let worklogsTable = `
                    <div class="project-section">
                        <h3>${projectConfig.projectName}</h3>
                        <table class="table table-striped">
                            <thead>
                                <tr>
                                    <th>Medewerker</th>
                                    ${configs.map(config => `<th>${config.columnName}</th>`).join('')}
                                    <th>Totaal</th>
                                </tr>
                            </thead>
                            <tbody>
                        `;

                        // Maak een map om de totalen per kolom bij te houden
                        const columnTotals = new Map<string, number>();
                        configs.forEach(config => {
                            columnTotals.set(config.columnName, 0);
                        });
                        let grandTotal = 0;

                        // Toon resultaten per medewerker
                        projectHoursByEmployeeAndCategory.forEach((employeeCategories, employee) => {
                            worklogsTable += `<tr><td>${employee}</td>`;
                            let employeeTotal = 0;

                            configs.forEach(config => {
                                let hours = employeeCategories.get(config.columnName) || 0;
                                
                                // Voor de 'Ontwikkeling' kolom gebruiken we de berekende waarde
                                if (config.columnName === 'Ontwikkeling') {
                                    hours = employeeCategories.get(config.columnName) || 0;
                                }
                                
                                employeeTotal += hours;
                                worklogsTable += `<td>${hours.toFixed(1)}</td>`;
                                
                                // Update totaal voor deze kolom
                                columnTotals.set(config.columnName, (columnTotals.get(config.columnName) || 0) + hours);
                                
                                // Voeg de uren toe aan de totale uren per medewerker en categorie
                                if (!totalHoursByEmployeeAndCategory.has(employee)) {
                                    totalHoursByEmployeeAndCategory.set(employee, new Map<string, number>());
                                }
                                const totalEmployeeCategories = totalHoursByEmployeeAndCategory.get(employee)!;
                                const currentTotalHours = totalEmployeeCategories.get(config.columnName) || 0;
                                totalEmployeeCategories.set(config.columnName, currentTotalHours + hours);
                            });

                            grandTotal += employeeTotal;
                            worklogsTable += `<td>${employeeTotal.toFixed(1)}</td></tr>`;
                        });

                        // Voeg totaalregel toe
                        worklogsTable += `
                            <tr class="table-dark">
                                <td><strong>Totaal</strong></td>
                                ${configs.map(config => 
                                    `<td><strong>${(columnTotals.get(config.columnName) || 0).toFixed(1)}</strong></td>`
                                ).join('')}
                                <td><strong>${grandTotal.toFixed(1)}</strong></td>
                            </tr>
                        `;

                        worklogsTable += `
                            </tbody>
                        </table>
                    </div>
                `;

                worklogsHtml += worklogsTable;
            }
        }

        // Genereer de totale worklogs tabel
        const totalWorklogsTable = generateTotalWorklogsTableFromData(totalHoursByEmployeeAndCategory);
        worklogsHtml += totalWorklogsTable;

        res.send(`
            <!DOCTYPE html>
            <html>
                <head>
                    <title>Worklogs</title>
                    <link rel="stylesheet" href="https://stackpath.bootstrapcdn.com/bootstrap/4.5.2/css/bootstrap.min.css">
                    <style>
                        .project-section {
                            margin-bottom: 2rem;
                        }
                        table {
                            margin-bottom: 1rem;
                        }
                        th, td {
                            text-align: right;
                        }
                        th:first-child, td:first-child {
                            text-align: left;
                        }
                    </style>
                </head>
                <body>
                    <div class="container mt-4">
                        <h2>Worklogs</h2>
                        ${worklogsHtml}
                    </div>
                </body>
            </html>
        `);
    } catch (error) {
        logger.error(`Error bij ophalen van worklogs: ${error}`);
        res.status(500).json({ error: 'Er is een fout opgetreden bij het ophalen van de worklogs' });
    }
});

function generateHtml(
    projectIssues: Record<string, JiraIssue[]>,
    projectPlanning: Record<string, PlanningResult>,
    googleSheetsData: GoogleSheetsData,
    worklogs: WorkLog[],
    sprintNames: string[]
): string {
    const projectNames = Object.keys(projectPlanning);
    
    let html = `
        <!DOCTYPE html>
        <html lang="nl">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Planning Overzicht</title>
            <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/css/bootstrap.min.css" rel="stylesheet">
        </head>
        <body>
            <div class="container-fluid">
                <ul class="nav nav-tabs" id="projectTabs" role="tablist">
                    ${projectNames.map((projectName, index) => `
                        <li class="nav-item" role="presentation">
                            <button class="nav-link ${index === 0 ? 'active' : ''}" 
                                    id="project-${index}-tab" 
                                    data-bs-toggle="tab" 
                                    data-bs-target="#project-${index}" 
                                    type="button" 
                                    role="tab">
                                ${projectName}
                            </button>
                        </li>
                    `).join('')}
                </ul>
                
                <div class="tab-content" id="projectTabContent">
                    ${projectNames.map((projectName, index) => {
                        const planning = projectPlanning[projectName];
                        return `
                            <div class="tab-pane fade ${index === 0 ? 'show active' : ''}" 
                                 id="project-${index}" 
                                 role="tabpanel">
                                <h2>${projectName}</h2>
                                ${generateSprintHoursTable(planning.sprintCapacity, planning.employeeSprintUsedHours, googleSheetsData, worklogs, sprintNames)}
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
            <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/js/bootstrap.bundle.min.js"></script>
        </body>
        </html>
    `;
    return html;
}

function generateSprintHoursTable(
    sprintCapacity: SprintCapacity[],
    employeeSprintUsedHours: {
        employee: string;
        sprintHours: {
            sprint: string;
            hours: number;
            issues: { key: string; hours: number }[];
        }[];
    }[],
    googleSheetsData: GoogleSheetsData,
    worklogs: WorkLog[],
    sprintNames: string[]
): string {
    let html = `
        <table class="table table-striped table-bordered">
            <thead>
                <tr>
                    <th>Medewerker</th>
                    ${sprintNames.map(sprint => `<th>${sprint}</th>`).join('')}
                </tr>
            </thead>
            <tbody>
                ${employeeSprintUsedHours.map(employee => {
                    const employeeCapacity = sprintCapacity.filter(cap => cap.employee === employee.employee);
                    return `
                        <tr>
                            <td>${employee.employee}</td>
                            ${sprintNames.map(sprint => {
                                const sprintData = employee.sprintHours.find(sh => sh.sprint === sprint);
                                const capacity = employeeCapacity.find(cap => cap.sprint === sprint)?.capacity || 0;
                                const hours = sprintData?.hours || 0;
                                return `<td>${hours} / ${capacity}</td>`;
                            }).join('')}
                        </tr>
                    `;
                }).join('')}
            </tbody>
        </table>
    `;
    return html;
}

// Hulpfunctie om Issue[] om te zetten naar JiraIssue[]
function convertIssuesToJiraIssues(issues: Issue[]): JiraIssue[] {
    return issues
        .filter(issue => issue.fields && issue.fields.summary && issue.fields.priority && issue.fields.assignee)
        .map(issue => ({
            id: issue.key,
            key: issue.key,
            fields: {
                summary: issue.fields!.summary!,
                priority: issue.fields!.priority!,
                assignee: issue.fields!.assignee!,
                timeestimate: issue.fields!.timeestimate || 0,
                status: issue.fields!.status,
                timeoriginalestimate: issue.fields!.timeoriginalestimate,
                worklog: issue.fields!.worklog as any // eventueel aanpassen indien nodig
            }
        }));
}