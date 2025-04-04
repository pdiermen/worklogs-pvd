import express, { Request, Response, RequestHandler, NextFunction } from 'express';
import type { Issue, IssueLink, EfficiencyData } from './types.js';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import { logger } from './logger.js';
import { getActiveIssues, getWorkLogs, getPlanning, jiraClient } from './jira.js';
import cors from 'cors';
import { WorkLogsResponse, WorkLog } from './types.js';
import { JIRA_DOMAIN } from './config.js';
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Laad .env.local bestand
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

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

// Configureer axios interceptors voor error handling
jiraClient.interceptors.response.use(
    response => response,
    error => {
        console.error('Jira API Error:', error.response?.data || error.message);
        return Promise.reject(new Error(error.response?.data?.errorMessages?.[0] || error.message));
    }
);

async function getGoogleSheetsData(): Promise<string[][] | null> {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Employees!A:H'
        });
        return response.data.values as string[][];
    } catch (error) {
        return null;
    }
}

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

function calculateEfficiency(issues: Issue[], worklogs: WorkLog[], startDate: Date, endDate: Date): EfficiencyData[] {
    // Filter issues die als "Closed" zijn gemarkeerd binnen de opgegeven periode
    const closedIssues = issues.filter(issue => {
        if (!issue.changelog?.histories) return false;
        
        return issue.changelog.histories.some(history => {
            const historyDate = new Date(history.created);
            return historyDate >= startDate && 
                   historyDate <= endDate &&
                   history.items.some(item => 
                       item.field === 'status' && 
                       item.toString === 'Closed'
                   );
        });
    });

    // Maak een map van medewerkers naar hun worklogs en issues
    const employeeData = new Map<string, {
        worklogs: WorkLog[],
        issues: Issue[]
    }>();

    // Verwerk alle closed issues en hun worklogs
    closedIssues.forEach(issue => {
        // Vind alle worklogs voor dit issue
        const issueWorklogs = worklogs.filter(worklog => worklog.issueKey === issue.key);
        
        // Voor elke unieke medewerker die op dit issue heeft gelogd
        const uniqueAuthors = new Set(issueWorklogs.map(worklog => worklog.author));
        
        uniqueAuthors.forEach(author => {
            if (!employeeData.has(author)) {
                employeeData.set(author, {
                    worklogs: [],
                    issues: []
                });
            }
            
            // Voeg het issue toe aan de issues van deze medewerker
            employeeData.get(author)!.issues.push(issue);
            
            // Voeg alle worklogs van deze medewerker voor dit issue toe
            const authorWorklogs = issueWorklogs.filter(worklog => worklog.author === author);
            employeeData.get(author)!.worklogs.push(...authorWorklogs);
        });
    });

    // Bereken efficiëntie per medewerker
    return Array.from(employeeData.entries()).map(([employee, data]) => {
        // Bereken totaal geplande uren (original estimate) voor closed issues waar deze medewerker op heeft gelogd
        const totalEstimatedHours = data.issues.reduce((sum, issue) => {
            const originalEstimate = issue.fields?.timeoriginalestimate || 0;
            return sum + originalEstimate / 3600;
        }, 0);

        // Bereken totaal gelogde uren voor closed issues van deze medewerker
        const totalLoggedHours = data.worklogs.reduce((sum, worklog) => {
            return sum + worklog.timeSpentSeconds / 3600;
        }, 0);

        // Bereken efficiëntie
        const efficiency = totalEstimatedHours > 0 ? (totalLoggedHours / totalEstimatedHours) * 100 : 0;

        return {
            assignee: employee,
            estimated: totalEstimatedHours.toFixed(1),
            logged: totalLoggedHours.toFixed(1),
            efficiency: efficiency.toFixed(1)
        };
    });
}

app.get('/worklogs', (req, res) => {
    const styles = `
        body { font-family: Arial, sans-serif; margin: 20px; }
        table { border-collapse: collapse; width: 100%; margin-bottom: 20px; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
        th { background-color: #f2f2f2; }
        .card { margin-bottom: 20px; }
        .card-header { background-color: #f8f9fa; padding: 10px; }
        .card-body { padding: 15px; }
        .form-label { margin-bottom: 5px; }
        .form-control { margin-bottom: 10px; }
        .btn-primary { margin-top: 24px; }
        .alert { margin-bottom: 15px; }
        .date-input { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; }
        .worklogs-form { margin-bottom: 20px; }
    `;

    const html = `
        <!DOCTYPE html>
        <html lang="nl">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Worklogs Dashboard</title>
            <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
            <style>
                ${styles}
            </style>
        </head>
        <body>
            <div class="container-fluid">
                <div class="d-flex justify-content-between align-items-center my-4">
                    <h1>Worklogs Dashboard</h1>
                    <a href="/" class="btn btn-secondary">Terug naar Planning</a>
                </div>
                <div class="card mb-4">
                    <div class="card-header">
                        <h5 class="mb-0">Worklogs</h5>
                    </div>
                    <div class="card-body">
                        <div class="row mb-3">
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
                                <button type="button" class="btn btn-primary w-100" onclick="loadWorklogs()">Laad Worklogs</button>
                            </div>
                        </div>
                        <div id="worklogsContainer">
                            <div class="alert alert-info">
                                Selecteer een begin- en einddatum om de worklogs te bekijken.
                            </div>
                            <table class="table">
                                <thead>
                                    <tr>
                                        <th>Datum</th>
                                        <th>Medewerker</th>
                                        <th>Issue</th>
                                        <th>Samenvatting</th>
                                        <th>Uren</th>
                                    </tr>
                                </thead>
                                <tbody>
                                </tbody>
                            </table>
                        </div>
                        <div id="efficiencyContainer"></div>
                    </div>
                </div>
            </div>
            <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
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

app.get('/', async (req, res) => {
    try {
        // Haal issues op
        let issues;
        try {
            issues = await getActiveIssues();
        } catch (error) {
            console.error('Error bij ophalen van active issues:', error);
            throw error;
        }

        // Haal Google Sheets data op
        let googleSheetsData;
        try {
            googleSheetsData = await getGoogleSheetsData();
        } catch (error) {
            console.error('Error bij ophalen van Google Sheets data:', error);
            throw error;
        }

        // Haal sprint namen op voor alle issues
        const sprintNames = new Map<string, string>();
        for (const issue of issues) {
            if (issue.fields?.customfield_10020 && issue.fields.customfield_10020.length > 0) {
                try {
                    sprintNames.set(issue.key, await getSprintName(issue));
                } catch (error) {
                    console.error(`Error bij ophalen sprint naam voor issue ${issue.key}:`, error);
                }
            }
        }

        // Splits issues in projecten
        const subscriptionIssues = issues.filter(issue => {
            const parentKey = issue.fields?.parent?.key;
            return parentKey === 'EET-5236' || parentKey === 'EET-6096' || parentKey === 'EET-5235';
        });

        const atlantisIssues = issues.filter(issue => {
            const parentKey = issue.fields?.parent?.key;
            return parentKey !== 'EET-5236' && parentKey !== 'EET-6096' && parentKey !== 'EET-5235';
        });

        // Bereken planning voor beide projecten
        const subscriptionPlanning = calculatePlanning(subscriptionIssues, 'subscription', googleSheetsData);
        const atlantisPlanning = calculatePlanning(atlantisIssues, 'atlantis', googleSheetsData);

        // Genereer HTML
        const html = generateHtml(issues, googleSheetsData, [], sprintNames);
        res.send(html);
    } catch (error) {
        console.error('Error in root route:', error);
        res.status(500).send(`
            <div class="alert alert-danger">
                Er is een fout opgetreden bij het ophalen van de data. 
                Probeer de pagina te verversen of neem contact op met de beheerder als het probleem aanhoudt.
                <br><br>
                Error details: ${error instanceof Error ? error.message : String(error)}
            </div>
        `);
    }
});

function getPredecessors(issue: Issue): string[] {
    if (!issue.fields?.issuelinks) return [];
    return issue.fields.issuelinks
        .filter((link: IssueLink) => link.type.name === 'Predecessor')
        .map((link: IssueLink) => {
            if (link.inwardIssue && link.outwardIssue) {
                return link.outwardIssue.key;
            }
            return '';
        })
        .filter(key => key !== '');
}

function getSuccessors(issue: Issue): string[] {
    if (!issue.fields?.issuelinks) return [];
    return issue.fields.issuelinks
        .filter((link: IssueLink) => link.type.name === 'Predecessor')
        .map((link: IssueLink) => {
            if (link.inwardIssue) return link.inwardIssue.key;
            return '';
        })
        .filter(key => key !== '');
}

function formatTime(seconds: number | undefined): string {
    if (seconds === undefined || seconds === null) return '-';
    return Number((seconds / 3600).toFixed(1)).toString();
}

// Functie om issues te sorteren volgens de gewenste volgorde
function sortIssues(issues: Issue[]): Issue[] {
    // Status prioriteit mapping
    const statusPriority = {
        'Resolved': 1,
        'In Review': 2,
        'Open': 3,
        'Registered': 4
    };

    // Prioriteit mapping
    const priorityOrder = {
        'Highest': 1,
        'High': 2,
        'Medium': 3,
        'Low': 4,
        'Lowest': 5
    };

    return [...issues].sort((a, b) => {
        const statusA = a.fields?.status?.name || '';
        const statusB = b.fields?.status?.name || '';
        
        // Eerst sorteren op status
        if (statusPriority[statusA as keyof typeof statusPriority] !== statusPriority[statusB as keyof typeof statusPriority]) {
            return (statusPriority[statusA as keyof typeof statusPriority] || 999) - (statusPriority[statusB as keyof typeof statusPriority] || 999);
        }

        // Voor Registered issues, eerst sorteren op aanwezigheid van opvolgers
        if (statusA === 'Registered' && statusB === 'Registered') {
            const hasSuccessorsA = getSuccessors(a).length > 0;
            const hasSuccessorsB = getSuccessors(b).length > 0;
            
            if (hasSuccessorsA !== hasSuccessorsB) {
                return hasSuccessorsA ? -1 : 1;
            }
            
            // Als beide issues opvolgers hebben of beide niet, sorteren op prioriteit
            const priorityA = a.fields?.priority?.name || '';
            const priorityB = b.fields?.priority?.name || '';
            
            if (priorityOrder[priorityA as keyof typeof priorityOrder] !== priorityOrder[priorityB as keyof typeof priorityOrder]) {
                return (priorityOrder[priorityA as keyof typeof priorityOrder] || 999) - (priorityOrder[priorityB as keyof typeof priorityOrder] || 999);
            }

            // Als prioriteit gelijk is, sorteren op naam van de toegewezen persoon
            const assigneeA = a.fields?.assignee?.displayName || 'Niet toegewezen';
            const assigneeB = b.fields?.assignee?.displayName || 'Niet toegewezen';
            return assigneeA.localeCompare(assigneeB);
        }

        // Voor niet-Registered issues, sorteren op prioriteit
        const priorityA = a.fields?.priority?.name || '';
        const priorityB = b.fields?.priority?.name || '';
        
        if (priorityOrder[priorityA as keyof typeof priorityOrder] !== priorityOrder[priorityB as keyof typeof priorityOrder]) {
            return (priorityOrder[priorityA as keyof typeof priorityOrder] || 999) - (priorityOrder[priorityB as keyof typeof priorityOrder] || 999);
        }

        // Als prioriteit gelijk is, sorteren op naam van de toegewezen persoon
        const assigneeA = a.fields?.assignee?.displayName || 'Niet toegewezen';
        const assigneeB = b.fields?.assignee?.displayName || 'Niet toegewezen';
        return assigneeA.localeCompare(assigneeB);
    });
}

function calculatePlanning(issues: Issue[], projectType: string, googleSheetsData: string[][] | null): { issue: Issue; sprint: number }[] {
    const planning: { issue: Issue; sprint: number }[] = [];
    const sprintCapacity = new Map<number, Map<string, number>>();
    const sprintAssignments = new Map<number, Map<string, Issue[]>>();
    const employeeHours = new Map<string, number>();
    const employeeSprintHours = new Map<string, Map<number, number>>();

    // Filter issues op basis van project type
    const filteredIssues = issues.filter(issue => {
        const issueType = issue.fields?.issuetype?.name?.toLowerCase() || '';
        if (projectType === 'Development') {
            return issueType === 'task' || issueType === 'bug';
        } else if (projectType === 'Support') {
            return issueType === 'incident' || issueType === 'problem';
        }
        return true;
    });

    // Sorteer issues volgens dezelfde logica als in de projecttabellen
    const sortedIssues = sortIssues(filteredIssues);

    // Initialiseer sprint capaciteit en assignments
    for (let sprint = 1; sprint <= 10; sprint++) {
        sprintCapacity.set(sprint, new Map<string, number>());
        sprintAssignments.set(sprint, new Map<string, Issue[]>());
    }

    // Bereken beschikbare uren per medewerker per sprint
    if (googleSheetsData) {
        googleSheetsData.slice(1).forEach((row: string[]) => {
            const employee = row[2];
            const effectiveHours = parseFloat(row[6]) || 0;
            const sprintHours = effectiveHours * 2; // 2 weken per sprint

            // Initialiseer employeeSprintHours voor deze medewerker
            if (!employeeSprintHours.has(employee)) {
                employeeSprintHours.set(employee, new Map<number, number>());
            }

            // Voor Peter van Diermen, verdeel de uren over alle sprints
            if (employee === 'Peter van Diermen') {
                for (let sprint = 1; sprint <= 10; sprint++) {
                    const sprintMap = sprintCapacity.get(sprint);
                    if (sprintMap) {
                        sprintMap.set(employee, sprintHours);
                    }
                    const employeeMap = employeeSprintHours.get(employee);
                    if (employeeMap) {
                        employeeMap.set(sprint, sprintHours);
                    }
                }
            } else {
                // Voor andere medewerkers, gebruik de normale sprint capaciteit
                for (let sprint = 1; sprint <= 10; sprint++) {
                    const sprintMap = sprintCapacity.get(sprint);
                    if (sprintMap) {
                        sprintMap.set(employee, sprintHours);
                    }
                    const employeeMap = employeeSprintHours.get(employee);
                    if (employeeMap) {
                        employeeMap.set(sprint, sprintHours);
                    }
                }
            }
        });
    }

    // Helper functie om remaining time of estimated time te krijgen
    function getIssueHours(issue: Issue): number {
        const remainingTime = issue.fields?.timeestimate;
        const estimatedTime = issue.fields?.timeoriginalestimate;
        return Number(((remainingTime !== undefined && remainingTime !== 0 ? remainingTime : estimatedTime || 0) / 3600).toFixed(1));
    }

    // Helper functie om te controleren of een issue aan een sprint kan worden toegewezen
    function canAssignToSprint(issue: Issue, sprint: number, employee: string): boolean {
        const issueHours = getIssueHours(issue);
        const sprintMap = sprintCapacity.get(sprint);
        const currentHours = sprintMap?.get(employee) || 0;
        return currentHours >= issueHours;
    }

    // Helper functie om een issue aan een sprint toe te wijzen
    function assignToSprint(issue: Issue, sprint: number, employee: string) {
        const issueHours = getIssueHours(issue);
        const sprintMap = sprintCapacity.get(sprint);
        if (sprintMap) {
            sprintMap.set(employee, (sprintMap.get(employee) || 0) - issueHours);
        }
        const sprintAssignmentsMap = sprintAssignments.get(sprint);
        if (sprintAssignmentsMap) {
            const employeeIssues = sprintAssignmentsMap.get(employee) || [];
            employeeIssues.push(issue);
            sprintAssignmentsMap.set(employee, employeeIssues);
        }
        planning.push({ issue, sprint });
    }

    // Verwerk eerst alle issues van andere medewerkers
    for (const issue of sortedIssues) {
        const assignee = issue.fields?.assignee?.displayName;
        if (!assignee || assignee === 'Peter van Diermen') continue;

        const issueHours = getIssueHours(issue);

        // Voor andere medewerkers, gebruik de normale toewijzingslogica
        let assigned = false;
        for (let sprint = 1; sprint <= 10; sprint++) {
            if (canAssignToSprint(issue, sprint, assignee)) {
                assignToSprint(issue, sprint, assignee);
                assigned = true;
                break;
            }
        }

        // Als er geen sprint beschikbaar is, wijs toe aan sprint 10
        if (!assigned) {
            assignToSprint(issue, 10, assignee);
        }
    }

    // Bereken beschikbare uren per sprint voor Peter van Diermen
    const peterSprintAvailableHours = new Map<number, number>();
    
    // Bereken eerst de beschikbare uren per sprint voor Peter
    for (let sprint = 1; sprint <= 10; sprint++) {
        let sprintTotalAvailable = 0;
        let sprintTotalUsed = 0;
        
        // Bereken totaal beschikbare uren in de sprint
        employeeSprintHours.forEach((sprintHours, employee) => {
            if (employee === 'Peter van Diermen') return;
            const hours = sprintHours.get(sprint);
            if (typeof hours === 'number') {
                sprintTotalAvailable += hours;
            }
        });
        
        // Bereken totaal gebruikte uren in de sprint
        sprintCapacity.forEach((sprintMap, sprintNum) => {
            sprintMap.forEach((remainingHours, employee) => {
                if (employee === 'Peter van Diermen') return;
                const employeeHours = employeeSprintHours.get(employee);
                if (employeeHours) {
                    const originalHours = employeeHours.get(sprintNum) || 0;
                    if (typeof originalHours === 'number' && typeof remainingHours === 'number') {
                        sprintTotalUsed += originalHours - remainingHours;
                    }
                }
            });
        });
        
        // Beschikbare uren voor Peter is het totaal aantal uren dat over is in de sprint
        const availableForPeter = Number((sprintTotalAvailable - sprintTotalUsed).toFixed(1));
        peterSprintAvailableHours.set(sprint, availableForPeter);
        
        // Update de sprint capaciteit voor Peter
        const sprintMap = sprintCapacity.get(sprint);
        if (sprintMap) {
            sprintMap.set('Peter van Diermen', availableForPeter);
        }
    }

    // Verzamel alle issues van Peter van Diermen
    const peterIssues = sortedIssues.filter(issue => 
        issue.fields?.assignee?.displayName === 'Peter van Diermen'
    );

    // Verdeel Peter's issues over de sprints
    for (const issue of peterIssues) {
        const issueHours = getIssueHours(issue);

        // Probeer het issue in één sprint te plaatsen als er voldoende capaciteit is
        let assigned = false;
        for (let sprint = 1; sprint <= 10; sprint++) {
            const availableHours = peterSprintAvailableHours.get(sprint) || 0;
            
            if (availableHours >= issueHours) {
                assignToSprint(issue, sprint, 'Peter van Diermen');
                peterSprintAvailableHours.set(sprint, availableHours - issueHours);
                assigned = true;
                break;
            }
        }

        // Als het issue niet in één sprint past, verdeel het over meerdere sprints
        if (!assigned) {
            let remainingHours = issueHours;
            let currentSprint = 1;

            while (remainingHours > 0 && currentSprint <= 10) {
                const availableHours = peterSprintAvailableHours.get(currentSprint) || 0;

                if (availableHours > 0) {
                    const hoursToAssign = Math.min(remainingHours, availableHours);
                    // Maak een kopie van het issue met aangepaste uren
                    const issueCopy = {
                        ...issue,
                        fields: {
                            ...issue.fields,
                            timeestimate: hoursToAssign * 3600,
                            timeoriginalestimate: hoursToAssign * 3600
                        }
                    };
                    assignToSprint(issueCopy, currentSprint, 'Peter van Diermen');
                    peterSprintAvailableHours.set(currentSprint, availableHours - hoursToAssign);
                    remainingHours -= hoursToAssign;
                }
                currentSprint++;
            }

            // Als er nog uren over zijn, wijs ze toe aan de laatste sprint
            if (remainingHours > 0) {
                const issueCopy = {
                    ...issue,
                    fields: {
                        ...issue.fields,
                        timeestimate: remainingHours * 3600,
                        timeoriginalestimate: remainingHours * 3600
                    }
                };
                assignToSprint(issueCopy, 10, 'Peter van Diermen');
            }
        }
    }

    return planning;
}

function getSprintName(issue: Issue): string {
    const sprints = issue.fields?.customfield_10020;
    if (!sprints || sprints.length === 0) {
        return 'Niet gepland';
    }
    // Neem de eerste actieve sprint
    const activeSprint = sprints.find(sprint => sprint.state === 'active');
    if (activeSprint) {
        return activeSprint.name;
    }
    // Als er geen actieve sprint is, neem de eerste sprint
    return sprints[0].name;
}

function getPersonStats(issues: Issue[]): { name: string; issueCount: number; totalRemainingTime: number }[] {
    const statsMap = new Map<string, { issueCount: number; totalRemainingTime: number }>();
    
    issues.forEach(issue => {
        const assignee = issue.fields?.assignee?.displayName || 'Niet toegewezen';
        const currentStats = statsMap.get(assignee) || { issueCount: 0, totalRemainingTime: 0 };
        
        statsMap.set(assignee, {
            issueCount: currentStats.issueCount + 1,
            totalRemainingTime: currentStats.totalRemainingTime + (issue.fields?.timeestimate || 0)
        });
    });

    return Array.from(statsMap.entries()).map(([name, stats]) => ({
        name,
        issueCount: stats.issueCount,
        totalRemainingTime: stats.totalRemainingTime
    }));
}

function getSprintHours(sprintPlanning: { issue: Issue; sprint: number }[], projectType: 'atlantis' | 'subscription'): { sprint: number; person: string; hours: number }[] {
    const sprintHoursMap = new Map<number, Map<string, number>>();
    
    sprintPlanning.forEach(({ issue, sprint }) => {
        const assignee = issue.fields?.assignee?.displayName || 'Niet toegewezen';
        const hours = Number(((issue.fields?.timeestimate || 0) / 3600).toFixed(1)); // Converteer naar uren en rond af op 1 decimaal
        
        const sprintMap = sprintHoursMap.get(sprint) || new Map<string, number>();
        const currentHours = sprintMap.get(assignee) || 0;
        sprintMap.set(assignee, Number((currentHours + hours).toFixed(1))); // Rond de som af op 1 decimaal
        sprintHoursMap.set(sprint, sprintMap);
    });

    const result: { sprint: number; person: string; hours: number }[] = [];
    sprintHoursMap.forEach((personMap, sprint) => {
        personMap.forEach((hours, person) => {
            result.push({ sprint, person, hours });
        });
    });

    return result.sort((a, b) => {
        if (a.sprint !== b.sprint) return a.sprint - b.sprint;
        return a.person.localeCompare(b.person);
    });
}

function getAvailableHoursForProject(googleSheetsData: string[][] | null, projectName: string): number {
    if (!googleSheetsData) return 0;
    const totalHours = googleSheetsData.slice(1).reduce((sum, row) => {
        const projects = (row[7] || '').split(',').map(p => p.trim());
        if (projects.includes(projectName)) {
            const effectiveHours = Number((parseFloat(row[6]) || 0).toFixed(1)); // Rond effectieve uren af op 1 decimaal
            return sum + Number((effectiveHours * 2).toFixed(1)); // Rond sprint capaciteit af op 1 decimaal
        }
        return sum;
    }, 0);
    return Number(totalHours.toFixed(1)); // Rond eindtotaal af op 1 decimaal
}

function generateHtml(issues: Issue[], googleSheetsData: string[][] | null, workLogs: WorkLog[], sprintNames: Map<string, string>): string {
    // Splits issues in projecten
    const subscriptionIssues = issues.filter(issue => {
        const parentKey = issue.fields?.parent?.key;
        return parentKey === 'EET-5236' || parentKey === 'EET-6096' || parentKey === 'EET-5235';
    });

    const atlantisIssues = issues.filter(issue => {
        const parentKey = issue.fields?.parent?.key;
        return parentKey !== 'EET-5236' && parentKey !== 'EET-6096' && parentKey !== 'EET-5235';
    });

    // Bereken planning voor beide projecten
    const subscriptionPlanning = calculatePlanning(subscriptionIssues, 'subscription', googleSheetsData);
    const atlantisPlanning = calculatePlanning(atlantisIssues, 'atlantis', googleSheetsData);

    // Styles voor de pagina
    const styles = `
        body { font-family: Arial, sans-serif; margin: 20px; }
        table { border-collapse: collapse; width: 100%; margin-bottom: 20px; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
        th { background-color: #f2f2f2; }
        .relationship { margin: 5px 0; }
        .nav-link { margin: 10px 0; }
        .card { margin-bottom: 20px; }
        .card-header { background-color: #f8f9fa; padding: 10px; }
        .card-body { padding: 15px; }
        .form-label { margin-bottom: 5px; }
        .form-control { margin-bottom: 10px; }
        .btn-primary { margin-top: 24px; }
        .alert { margin-bottom: 15px; }
        .date-input { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; }
        .worklogs-form { margin-bottom: 20px; }
    `;

    // Project sectie
    const projectSection = `
        <div class="card mb-4">
            <div class="card-header">
                <h5 class="mb-0">Projecten</h5>
            </div>
            <div class="card-body">
                <div class="row">
                    <div class="col-md-6">
                        <h3>Subscriptions</h3>
                        <table class="table">
                            <thead>
                                <tr>
                                    <th>Issue</th>
                                    <th>Samenvatting</th>
                                    <th>Status</th>
                                    <th>Prioriteit</th>
                                    <th>Toegewezen aan</th>
                                    <th>Uren</th>
                                    <th>Opvolgers</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${sortIssues(subscriptionIssues.filter(issue => issue.fields?.status?.name !== 'Ready for testing')).map(issue => {
                                    // Haal opvolgers op
                                    const successors = getSuccessors(issue);
                                    const successorsHtml = successors.length > 0 
                                        ? successors.map(key => `<a href="https://deventit.atlassian.net/browse/${key}" target="_blank">${key}</a>`).join(', ')
                                        : 'Geen';
                                    
                                    // Gebruik remaining time (timeestimate) of toon '-' als deze niet beschikbaar is
                                    const remainingTime = issue.fields?.timeestimate;
                                    
                                    return `
                                        <tr>
                                            <td>${issue.key}</td>
                                            <td>${issue.fields?.summary}</td>
                                            <td>${issue.fields?.status?.name}</td>
                                            <td>${issue.fields?.priority?.name || 'Geen'}</td>
                                            <td>${issue.fields?.assignee?.displayName || 'Niet toegewezen'}</td>
                                            <td>${formatTime(remainingTime)}</td>
                                            <td>${successorsHtml}</td>
                                        </tr>
                                    `;
                                }).join('')}
                                <tr class="table-dark">
                                    <td colspan="5"><strong>Totaal</strong></td>
                                    <td><strong>${formatTime(subscriptionIssues.filter(issue => issue.fields?.status?.name !== 'Ready for testing').reduce((sum, issue) => {
                                        // Gebruik remaining time (timeestimate) of 0 als deze niet beschikbaar is
                                        const remainingTime = issue.fields?.timeestimate || 0;
                                        return sum + remainingTime;
                                    }, 0))}</strong></td>
                                    <td></td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <div class="col-md-6">
                        <h3>Atlantis 7</h3>
                        <table class="table">
                            <thead>
                                <tr>
                                    <th>Issue</th>
                                    <th>Samenvatting</th>
                                    <th>Status</th>
                                    <th>Prioriteit</th>
                                    <th>Toegewezen aan</th>
                                    <th>Uren</th>
                                    <th>Opvolgers</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${sortIssues(atlantisIssues.filter(issue => issue.fields?.status?.name !== 'Ready for testing')).map(issue => {
                                    // Haal opvolgers op
                                    const successors = getSuccessors(issue);
                                    const successorsHtml = successors.length > 0 
                                        ? successors.map(key => `<a href="https://deventit.atlassian.net/browse/${key}" target="_blank">${key}</a>`).join(', ')
                                        : 'Geen';
                                    
                                    // Gebruik remaining time (timeestimate) of toon '-' als deze niet beschikbaar is
                                    const remainingTime = issue.fields?.timeestimate;
                                    
                                    return `
                                        <tr>
                                            <td>${issue.key}</td>
                                            <td>${issue.fields?.summary}</td>
                                            <td>${issue.fields?.status?.name}</td>
                                            <td>${issue.fields?.priority?.name || 'Geen'}</td>
                                            <td>${issue.fields?.assignee?.displayName || 'Niet toegewezen'}</td>
                                            <td>${formatTime(remainingTime)}</td>
                                            <td>${successorsHtml}</td>
                                        </tr>
                                    `;
                                }).join('')}
                                <tr class="table-dark">
                                    <td colspan="5"><strong>Totaal</strong></td>
                                    <td><strong>${formatTime(atlantisIssues.filter(issue => issue.fields?.status?.name !== 'Ready for testing').reduce((sum, issue) => {
                                        // Gebruik remaining time (timeestimate) of 0 als deze niet beschikbaar is
                                        const remainingTime = issue.fields?.timeestimate || 0;
                                        return sum + remainingTime;
                                    }, 0))}</strong></td>
                                    <td></td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>
    `;

    // Planning sectie
    const planningSection = `
        <div class="card mb-4">
            <div class="card-header">
                <h5 class="mb-0">Planning</h5>
            </div>
            <div class="card-body">
                <div class="row">
                    <div class="col-md-6">
                        <h3>Subscriptions</h3>
                        ${generateSprintHoursTable(subscriptionPlanning, 'Subscriptions', googleSheetsData)}
                    </div>
                    <div class="col-md-6">
                        <h3>Atlantis 7</h3>
                        ${generateSprintHoursTable(atlantisPlanning, 'Atlantis', googleSheetsData)}
                    </div>
                </div>
            </div>
        </div>
    `;

    return `
        <!DOCTYPE html>
        <html lang="nl">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Planning Dashboard</title>
            <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
            <style>
                ${styles}
            </style>
        </head>
        <body>
            <div class="container-fluid">
                <h1 class="my-4">Planning Dashboard</h1>
                <div class="mb-4">
                    <a href="/worklogs" class="btn btn-primary">Bekijk Worklogs</a>
                </div>
                ${projectSection}
                ${planningSection}
            </div>
            <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
        </body>
        </html>
    `;
}

function generateSprintHoursTable(planning: { issue: Issue; sprint: number }[], projectType: string, googleSheetsData: string[][] | null): string {
    const sprintHoursMap = new Map<number, Map<string, number>>();
    const sprintNames = new Map<number, string>();
    const sprintAssignments = new Map<number, Map<string, Issue[]>>();

    // Verzamel alle unieke sprints en medewerkers
    const uniqueSprints = new Set(planning.map(p => p.sprint));
    const uniqueEmployees = new Set(planning.map(p => p.issue.fields?.assignee?.displayName || 'Niet toegewezen'));

    // Initialiseer de maps voor elke sprint
    uniqueSprints.forEach(sprint => {
        sprintHoursMap.set(sprint, new Map());
        sprintAssignments.set(sprint, new Map<string, Issue[]>());
        uniqueEmployees.forEach(employee => {
            sprintHoursMap.get(sprint)?.set(employee, 0);
            sprintAssignments.get(sprint)?.set(employee, []);
        });
    });

    // Helper functie om remaining time of estimated time te krijgen
    function getIssueHours(issue: Issue): number {
        const remainingTime = issue.fields?.timeestimate;
        const estimatedTime = issue.fields?.timeoriginalestimate;
        return Number(((remainingTime !== undefined && remainingTime !== 0 ? remainingTime : estimatedTime || 0) / 3600).toFixed(1));
    }

    // Vul de uren en assignments in
    planning.forEach(({ issue, sprint }) => {
        const assignee = issue.fields?.assignee?.displayName || 'Niet toegewezen';
        const hours = getIssueHours(issue);
        
        const sprintMap = sprintHoursMap.get(sprint);
        if (sprintMap) {
            sprintMap.set(assignee, (sprintMap.get(assignee) || 0) + hours);
        }

        const sprintAssignmentsMap = sprintAssignments.get(sprint);
        if (sprintAssignmentsMap) {
            const employeeIssues = sprintAssignmentsMap.get(assignee) || [];
            employeeIssues.push(issue);
            sprintAssignmentsMap.set(assignee, employeeIssues);
        }
    });

    // Verzamel alle unieke medewerkers en sorteer ze alfabetisch
    const uniqueEmployeesSprint = new Set<string>();
    planning.forEach(p => {
        if (p.issue.fields?.assignee?.displayName) {
            uniqueEmployeesSprint.add(p.issue.fields?.assignee?.displayName);
        }
    });
    const sortedEmployeesSprint = Array.from(uniqueEmployeesSprint).sort((a, b) => a.localeCompare(b));

    // Genereer de HTML tabel
    let sprintTable = `
        <h2>Uren per Sprint ${projectType}</h2>
        <table class="table">
            <thead>
                <tr>
                    <th>Sprint</th>
                    <th>Medewerker</th>
                    <th>Beschikbaar</th>
                    <th>Gebruikt</th>
                    <th>Over</th>
                    <th>Issues</th>
                </tr>
            </thead>
            <tbody>
                ${sortedEmployeesSprint.map(employee => {
                    const employeeLogs = planning.filter(p => p.issue.fields?.assignee?.displayName === employee);
                    const totalAvailable = employeeLogs.reduce((sum, p) => sum + getIssueHours(p.issue), 0);
                    const totalUsed = employeeLogs.reduce((sum, p) => sum + getIssueHours(p.issue), 0);
                    const totalRemaining = totalAvailable - totalUsed;
                    const issues = employeeLogs.map(p => ({
                        key: p.issue.key,
                        hours: getIssueHours(p.issue)
                    }));
                    return `
                        <tr>
                            <td>Sprint ${employeeLogs[0]?.sprint || 'Niet gepland'}</td>
                            <td>${employee}</td>
                            <td>${totalAvailable.toFixed(1)}</td>
                            <td>${totalUsed.toFixed(1)}</td>
                            <td>${totalRemaining.toFixed(1)}</td>
                            <td>
                                ${issues.map(issue => 
                                    `<div><a href="https://deventit.atlassian.net/browse/${issue.key}" target="_blank">${issue.key}</a> (${issue.hours} uur)</div>`
                                ).join('')}
                            </td>
                        </tr>
                    `;
                }).join('')}
            </tbody>
        </table>
    `;

    return sprintTable;
}

interface PlanningIssue {
    key: string;
    fields?: {
        summary?: string;
        status?: {
            name: string;
        };
        assignee?: {
            displayName: string;
        };
        timeestimate?: number;
    };
}

type PlanningResult = Record<string, PlanningIssue[]>;

// Planning endpoint
app.get('/api/planning', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const planning = await getPlanning() as unknown as PlanningResult;
        if (!planning) {
            return res.status(404).send(`
                <div class="alert alert-danger">
                    Geen planning data ontvangen.
                </div>
            `);
        }

        // Genereer HTML voor planning tabel
        const planningHtml = `
            <table class="table">
                <thead>
                    <tr>
                        <th>Sprint</th>
                        <th>Issue</th>
                        <th>Samenvatting</th>
                        <th>Status</th>
                        <th>Toegewezen aan</th>
                        <th>Uren</th>
                    </tr>
                </thead>
                <tbody>
                    ${Object.entries(planning).map(([sprint, issues]) => 
                        issues.map((issue: PlanningIssue) => `
                            <tr>
                                <td>Sprint ${sprint}</td>
                                <td><a href="https://${JIRA_DOMAIN}/browse/${issue.key}" target="_blank">${issue.key}</a></td>
                                <td>${issue.fields?.summary || ''}</td>
                                <td>${issue.fields?.status?.name || ''}</td>
                                <td>${issue.fields?.assignee?.displayName || 'Niet toegewezen'}</td>
                                <td>${formatTime(issue.fields?.timeestimate)}</td>
                            </tr>
                        `).join('')
                    ).join('')}
                </tbody>
            </table>
        `;

        res.send(planningHtml);
    } catch (error: any) {
        logger.error(`Error bij ophalen planning: ${error}`);
        res.status(500).send(`
            <div class="alert alert-danger">
                Er is een fout opgetreden bij het ophalen van de planning: ${error.message || error}
            </div>
        `);
    }
});

// Worklogs endpoint
app.get('/api/worklogs', async (req: Request, res: Response) => {
    try {
        const { startDate, endDate } = req.query;
        
        if (!startDate || !endDate) {
            return res.status(400).send(`
                <div class="alert alert-danger">
                    Start- en einddatum zijn verplicht.
                </div>
            `);
        }

        // Haal worklogs op van Jira
        const workLogsResponse = await getWorkLogs(startDate as string, endDate as string);
        
        // Log worklogs data in een leesbaar formaat
        logger.log('Worklogs data:');
        workLogsResponse.workLogs.forEach(log => {
            logger.log(`- ${log.author}: ${log.issueKey} (${(log.timeSpentSeconds / 3600).toFixed(1)} uur)`);
        });
        
        logger.log('Efficiency data:');
        workLogsResponse.efficiencyTable.forEach(row => {
            logger.log(`- ${row.assignee}: ${row.efficiency}% efficiëntie`);
        });
        
        // Haal alle issues op voor de efficiency tabel
        const closedIssuesJql = `project = ${process.env.JIRA_PROJECT} AND status = Closed AND status CHANGED TO Closed AFTER "${startDate}" AND status CHANGED TO Closed BEFORE "${endDate}" ORDER BY updated DESC`;
        
        const closedIssuesResponse = await jiraClient.get('/search', {
            params: {
                jql: closedIssuesJql,
                fields: ['summary', 'timetracking', 'assignee', 'status', 'timeestimate', 'timeoriginalestimate', 'worklog'],
                expand: ['changelog', 'worklog'],
                maxResults: 1000
            }
        });

        const closedIssues = closedIssuesResponse.data.issues || [];
        
        // Filter worklogs op basis van de geselecteerde periode
        const filteredWorklogs = workLogsResponse.workLogs.filter(log => {
            const logDate = new Date(log.started);
            return logDate >= new Date(startDate as string) && logDate <= new Date(endDate as string);
        });
        
        // Bereken efficiëntie
        const efficiencyTable = calculateEfficiency(closedIssues, filteredWorklogs, new Date(startDate as string), new Date(endDate as string));
        
        // Verzamel alle unieke medewerkers en sorteer ze alfabetisch
        const uniqueEmployees = new Set(workLogsResponse.workLogs.map(log => log.author));
        const sortedEmployees = Array.from(uniqueEmployees).sort((a, b) => a.localeCompare(b));

        // Genereer HTML voor worklogs tabel
        const worklogsHtml = `
            <table class="table">
                <thead>
                    <tr>
                        <th>Medewerker</th>
                        <th>Niet gewerkt</th>
                        <th>Niet op issues</th>
                        <th>Ontwikkeling</th>
                        <th>Totaal</th>
                    </tr>
                </thead>
                <tbody>
                    ${sortedEmployees.map(author => {
                        const authorLogs = workLogsResponse.workLogs.filter(log => log.author === author);
                        const nietGewerkt = authorLogs
                            .filter(log => log.issueKey === 'EET-3561')
                            .reduce((sum, log) => sum + log.timeSpentSeconds / 3600, 0);
                        const nietOpIssues = authorLogs
                            .filter(log => log.issueKey === 'EET-3560')
                            .reduce((sum, log) => sum + log.timeSpentSeconds / 3600, 0);
                        const ontwikkeling = authorLogs
                            .filter(log => log.issueKey !== 'EET-3561' && log.issueKey !== 'EET-3560')
                            .reduce((sum, log) => sum + log.timeSpentSeconds / 3600, 0);
                        const totaal = nietGewerkt + nietOpIssues + ontwikkeling;
                        
                        return `
                            <tr>
                                <td>${author}</td>
                                <td>${nietGewerkt.toFixed(1)}</td>
                                <td>${nietOpIssues.toFixed(1)}</td>
                                <td>${ontwikkeling.toFixed(1)}</td>
                                <td>${totaal.toFixed(1)}</td>
                            </tr>
                        `;
                    }).join('')}
                    ${(() => {
                        const totalNietGewerkt = workLogsResponse.workLogs
                            .filter(log => log.issueKey === 'EET-3561')
                            .reduce((sum, log) => sum + log.timeSpentSeconds / 3600, 0);
                        const totalNietOpIssues = workLogsResponse.workLogs
                            .filter(log => log.issueKey === 'EET-3560')
                            .reduce((sum, log) => sum + log.timeSpentSeconds / 3600, 0);
                        const totalOntwikkeling = workLogsResponse.workLogs
                            .filter(log => log.issueKey !== 'EET-3561' && log.issueKey !== 'EET-3560')
                            .reduce((sum, log) => sum + log.timeSpentSeconds / 3600, 0);
                        const totalTotaal = totalNietGewerkt + totalNietOpIssues + totalOntwikkeling;
                        
                        return `
                            <tr class="table-primary fw-bold">
                                <td>Totaal</td>
                                <td>${totalNietGewerkt.toFixed(1)}</td>
                                <td>${totalNietOpIssues.toFixed(1)}</td>
                                <td>${totalOntwikkeling.toFixed(1)}</td>
                                <td>${totalTotaal.toFixed(1)}</td>
                            </tr>
                        `;
                    })()}
                </tbody>
            </table>
        `;

        // Verzamel alle unieke medewerkers en sorteer ze alfabetisch voor de efficiency tabel
        const uniqueEmployeesEfficiency = new Set<string>();
        workLogsResponse.efficiencyTable.forEach(log => {
            if (log.assignee) uniqueEmployeesEfficiency.add(log.assignee);
        });
        const sortedEmployeesEfficiency = Array.from(uniqueEmployeesEfficiency).sort((a, b) => a.localeCompare(b));

        // Genereer de efficiency tabel
        let efficiencyTableHtml = `
            <h3>Efficiëntie</h3>
            <table class="table">
                <thead>
                    <tr>
                        <th>Medewerker</th>
                        <th>Geschat</th>
                        <th>Gelogd</th>
                        <th>Efficiëntie</th>
                    </tr>
                </thead>
                <tbody>
                    ${sortedEmployeesEfficiency.map(employee => {
                        const employeeLogs = workLogsResponse.efficiencyTable.filter(log => log.assignee === employee);
                        const totalEstimated = employeeLogs.reduce((sum, log) => sum + parseFloat(log.estimated), 0);
                        const totalLogged = employeeLogs.reduce((sum, log) => sum + parseFloat(log.logged), 0);
                        const totalEfficiency = totalEstimated > 0 ? ((totalLogged / totalEstimated) * 100).toFixed(1) : '0.0';
                        
                        return `
                            <tr>
                                <td>${employee}</td>
                                <td>${totalEstimated.toFixed(1)}</td>
                                <td>${totalLogged.toFixed(1)}</td>
                                <td>${totalEfficiency}%</td>
                            </tr>
                        `;
                    }).join('')}
                    ${(() => {
                        const totalEstimated = workLogsResponse.efficiencyTable.reduce((sum, log) => sum + parseFloat(log.estimated), 0);
                        const totalLogged = workLogsResponse.efficiencyTable.reduce((sum, log) => sum + parseFloat(log.logged), 0);
                        const totalEfficiency = totalEstimated > 0 ? ((totalLogged / totalEstimated) * 100).toFixed(1) : '0.0';
                        
                        return `
                            <tr class="table-primary fw-bold">
                                <td>Totaal</td>
                                <td>${totalEstimated.toFixed(1)}</td>
                                <td>${totalLogged.toFixed(1)}</td>
                                <td>${totalEfficiency}%</td>
                            </tr>
                        `;
                    })()}
                </tbody>
            </table>
        `;

        res.send(`
            <div class="worklogs-container">
                ${worklogsHtml}
                ${efficiencyTableHtml}
            </div>
        `);
    } catch (error: any) {
        logger.error(`Error in /api/worklogs endpoint: ${error}`);
        res.status(500).send(`
            <div class="alert alert-danger">
                Er is een fout opgetreden bij het ophalen van de worklogs: ${error.message || error}
            </div>
        `);
    }
});

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