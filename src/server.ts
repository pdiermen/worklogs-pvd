import express, { Request, Response, RequestHandler, NextFunction } from 'express';
import type { Issue, IssueLink } from './types.js';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import { logger } from './logger.js';
import { getActiveIssues, getWorkLogs, getPlanning } from './jira.js';
import cors from 'cors';
import { WorkLogsResponse } from './types';
import { JIRA_DOMAIN } from './config.js';

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

function calculateEfficiency(issues: Issue[], worklogs: WorkLog[], startDate: Date, endDate: Date): string {
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

    // Groepeer worklogs per issue
    const worklogsByIssue = worklogs.reduce((acc, worklog) => {
        if (!acc[worklog.issueKey]) {
            acc[worklog.issueKey] = [];
        }
        acc[worklog.issueKey].push(worklog);
        return acc;
    }, {} as Record<string, WorkLog[]>);

    // Bereken efficiëntie per gesloten issue
    const efficiencyData = closedIssues.map(issue => {
        const issueWorklogs = worklogsByIssue[issue.key] || [];
        const totalLoggedHours = issueWorklogs.reduce((sum, wl) => sum + wl.timeSpentSeconds / 3600, 0);
        const estimatedHours = (issue.fields?.timeestimate || 0) / 3600;
        const efficiency = estimatedHours > 0 ? (totalLoggedHours / estimatedHours) * 100 : 0;

        return {
            key: issue.key,
            summary: issue.fields?.summary || '',
            estimatedHours: estimatedHours.toFixed(1),
            loggedHours: totalLoggedHours.toFixed(1),
            efficiency: efficiency.toFixed(1)
        };
    });

    // Bereken totalen
    const totalEstimatedHours = efficiencyData.reduce((sum, data) => sum + parseFloat(data.estimatedHours), 0);
    const totalLoggedHours = efficiencyData.reduce((sum, data) => sum + parseFloat(data.loggedHours), 0);
    const totalEfficiency = totalEstimatedHours > 0 ? (totalLoggedHours / totalEstimatedHours) * 100 : 0;

    // Genereer HTML tabel
    let html = `
        <table class="table">
            <thead>
                <tr>
                    <th>Issue</th>
                    <th>Samenvatting</th>
                    <th>Geplande uren</th>
                    <th>Gelogde uren</th>
                    <th>Efficiëntie (%)</th>
                </tr>
            </thead>
            <tbody>
    `;

    efficiencyData.forEach(data => {
        html += `
            <tr>
                <td><a href="https://${JIRA_DOMAIN}/browse/${data.key}" target="_blank">${data.key}</a></td>
                <td>${data.summary}</td>
                <td>${data.estimatedHours}</td>
                <td>${data.loggedHours}</td>
                <td>${data.efficiency}</td>
            </tr>
        `;
    });

    // Voeg totalen rij toe
    html += `
            <tr class="table-dark">
                <td colspan="2"><strong>Totaal</strong></td>
                <td><strong>${totalEstimatedHours.toFixed(1)}</strong></td>
                <td><strong>${totalLoggedHours.toFixed(1)}</strong></td>
                <td><strong>${totalEfficiency.toFixed(1)}</strong></td>
            </tr>
            </tbody>
        </table>
    `;

    return html;
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
        const issues = await getActiveIssues();

        // Haal Google Sheets data op
        const googleSheetsData = await getGoogleSheetsData();

        // Haal sprint namen op voor alle issues
        const sprintNames = new Map<string, string>();
        for (const issue of issues) {
            if (issue.fields.customfield_10020 && issue.fields.customfield_10020.length > 0) {
                sprintNames.set(issue.key, await getSprintName(issue));
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
        const subscriptionPlanning = calculatePlanning(subscriptionIssues, googleSheetsData, 'subscription');
        const atlantisPlanning = calculatePlanning(atlantisIssues, googleSheetsData, 'atlantis');

        // Bereken uren per sprint voor beide projecten
        const subscriptionSprintHours = getSprintHours(subscriptionPlanning, 'subscription');
        const atlantisSprintHours = getSprintHours(atlantisPlanning, 'atlantis');

        // Genereer HTML
        const html = generateHtml(issues, googleSheetsData, [], sprintNames);
        res.send(html);
    } catch (error) {
        res.status(500).send('Er is een fout opgetreden bij het ophalen van de data.');
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
    if (!seconds) return '-';
    return Number((seconds / 3600).toFixed(1)).toString();
}

function calculatePlanning(issues: Issue[], googleSheetsData: string[][] | null, projectType: 'atlantis' | 'subscription'): { issue: Issue; sprint: number }[] {
    // Maak een map van effectieve uren en projecten per medewerker
    const employeeDataMap = new Map<string, { hours: number; projects: string[] }>();
    if (googleSheetsData) {
        googleSheetsData.slice(1).forEach(row => {
            const name = row[2];
            const effectiveHours = Number((parseFloat(row[6]) || 0).toFixed(1));
            const projects = (row[7] || '').split(',').map(p => p.trim());
            employeeDataMap.set(name, { hours: effectiveHours, projects });
        });
    }

    // Filter issues op basis van projecten waar medewerkers op werken
    const filteredIssues = issues.filter(issue => {
        const assignee = issue.fields?.assignee?.displayName;
        if (!assignee) return false;
        
        const employeeData = employeeDataMap.get(assignee);
        if (!employeeData) return false;

        // Voor Peter's issues, controleer of er medewerkers zijn die op het project kunnen werken
        if (assignee === 'Peter van Diermen') {
            const availableEmployees = Array.from(employeeDataMap.entries())
                .filter(([name, data]) => 
                    name !== 'Peter van Diermen' && 
                    data.projects.includes(projectType === 'atlantis' ? 'Atlantis 7' : 'Subscriptions')
                );
            return availableEmployees.length > 0;
        }

        // Voor andere medewerkers, controleer of ze op het juiste project werken
        return employeeData.projects.includes(projectType === 'atlantis' ? 'Atlantis 7' : 'Subscriptions');
    });

    // Sorteer issues op prioriteit (Highest -> High -> Medium -> Low)
    const priorityOrder = ['Highest', 'High', 'Medium', 'Low'];
    
    // Bereid issues voor met prioriteit en opvolgers
    const issuesWithPriority = filteredIssues.map(issue => ({
        issue,
        priority: priorityOrder.indexOf(issue.fields?.priority?.name || 'Low'),
        hasSuccessors: getSuccessors(issue).length > 0,
        hours: Number(((issue.fields?.timeestimate || 0) / 3600).toFixed(1)),
        isActive: issue.fields?.status?.name === 'Open' || issue.fields?.status?.name === 'In review',
        isWaiting: issue.fields?.status?.name === 'Waiting',
        predecessors: getPredecessors(issue),
        isPeterIssue: issue.fields?.assignee?.displayName === 'Peter van Diermen'
    }));

    // Sorteer issues op actieve status, prioriteit en opvolgers
    issuesWithPriority.sort((a, b) => {
        // Eerst op actieve status
        if (a.isActive !== b.isActive) return b.isActive ? 1 : -1;
        // Dan op opvolgers
        if (a.hasSuccessors !== b.hasSuccessors) return b.hasSuccessors ? 1 : -1;
        // Dan op prioriteit
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.issue.key.localeCompare(b.issue.key);
    });

    // Verdeel issues over sprints
    const sprintPlanning: { issue: Issue; sprint: number }[] = [];
    const sprintHours = new Map<number, Map<string, number>>(); // sprint -> medewerker -> uren
    const maxSprints = 10; // Maximum aantal sprints om te voorkomen dat we oneindig doorlopen

    // Initialiseer de eerste sprint
    sprintHours.set(1, new Map<string, number>());

    // Maak een map van issue keys naar hun sprint nummers
    const issueSprintMap = new Map<string, number>();

    // Eerst plannen we alle issues (inclusief Peter's issues)
    for (const { issue, hours, isActive, isWaiting, predecessors, isPeterIssue } of issuesWithPriority) {
        const assignee = issue.fields?.assignee?.displayName || 'Niet toegewezen';
        const employeeHours = employeeDataMap.get(assignee)?.hours || 0;
        const sprintCapacity = Number((employeeHours * 2).toFixed(1)); // 2 weken per sprint, afgerond op 1 decimaal

        // Zoek de eerste sprint waar deze issue past
        let assignedSprint = 1;
        let foundSprint = false;

        // Als het issue "Waiting" is, zoek de hoogste sprint van de voorgangers
        if (isWaiting && predecessors.length > 0) {
            const predecessorSprints = predecessors
                .map(predKey => issueSprintMap.get(predKey))
                .filter(sprint => sprint !== undefined);
            
            if (predecessorSprints.length > 0) {
                assignedSprint = Math.max(...predecessorSprints) + 1;
            }
        }

        // Controleer eerst de huidige sprint
        const currentSprintHours = sprintHours.get(assignedSprint)!;
        const currentEmployeeHours = Number((currentSprintHours.get(assignee) || 0).toFixed(1));

        // Als er nog tijd over is in de huidige sprint, plaats het issue daar
        if (currentEmployeeHours < sprintCapacity) {
            // Controleer of het issue binnen de resterende beschikbare tijd past
            const remainingCapacity = sprintCapacity - currentEmployeeHours;

            if (hours <= remainingCapacity) {
                // Update sprint uren
                currentSprintHours.set(assignee, currentEmployeeHours + hours);
                sprintHours.set(assignedSprint, currentSprintHours);
                foundSprint = true;
            } else {
                // Zoek de volgende sprint
                assignedSprint++;
                while (assignedSprint <= maxSprints) {
                    const sprintEmployeeHours = sprintHours.get(assignedSprint) || new Map<string, number>();
                    const employeeHoursInSprint = sprintEmployeeHours.get(assignee) || 0;

                    // Als er nog tijd over is in deze sprint, plaats het issue daar
                    if (employeeHoursInSprint < sprintCapacity) {
                        const remainingCapacity = sprintCapacity - employeeHoursInSprint;
                        if (hours <= remainingCapacity) {
                            // Update sprint uren
                            sprintEmployeeHours.set(assignee, employeeHoursInSprint + hours);
                            sprintHours.set(assignedSprint, sprintEmployeeHours);
                            foundSprint = true;
                            break;
                        }
                    }

                    assignedSprint++;
                }
            }
        } else {
            // Zoek de volgende sprint
            assignedSprint++;
            while (assignedSprint <= maxSprints) {
                const sprintEmployeeHours = sprintHours.get(assignedSprint) || new Map<string, number>();
                const employeeHoursInSprint = sprintEmployeeHours.get(assignee) || 0;

                // Als er nog tijd over is in deze sprint, plaats het issue daar
                if (employeeHoursInSprint < sprintCapacity) {
                    const remainingCapacity = sprintCapacity - employeeHoursInSprint;
                    if (hours <= remainingCapacity) {
                        // Update sprint uren
                        sprintEmployeeHours.set(assignee, employeeHoursInSprint + hours);
                        sprintHours.set(assignedSprint, sprintEmployeeHours);
                        foundSprint = true;
                        break;
                    }
                }

                assignedSprint++;
            }
        }

        if (!foundSprint) {
            // Toewijzen aan laatste sprint als fallback
            assignedSprint = maxSprints;
        }

        sprintPlanning.push({ issue, sprint: assignedSprint });
        issueSprintMap.set(issue.key, assignedSprint);
    }

    // Herverdeel Peter's issues over de beschikbare uren
    const peterIssues = sprintPlanning.filter(({ issue }) => 
        issue.fields?.assignee?.displayName === 'Peter van Diermen'
    );
    
    for (const { issue } of peterIssues) {
        const hours = Number(((issue.fields?.timeestimate || 0) / 3600).toFixed(1));

        // Zoek een sprint met voldoende beschikbare uren
        let foundSprint = false;
        for (let targetSprint = 1; targetSprint <= maxSprints; targetSprint++) {
            const sprintEmployeeHours = sprintHours.get(targetSprint) || new Map<string, number>();
            let totalAvailableHours = 0;
            const availableHoursPerPerson = new Map<string, number>();

            // Bereken beschikbare uren per persoon, alleen voor medewerkers die op het project kunnen werken
            for (const [assignee, employeeData] of employeeDataMap.entries()) {
                if (assignee === 'Peter van Diermen') continue;
                if (!employeeData.projects.includes(projectType === 'atlantis' ? 'Atlantis 7' : 'Subscriptions')) continue;

                const sprintCapacity = Number((employeeData.hours * 2).toFixed(1));
                const usedHours = Number((sprintEmployeeHours.get(assignee) || 0).toFixed(1));
                const availableHours = Number((Math.max(0, sprintCapacity - usedHours)).toFixed(1));
                availableHoursPerPerson.set(assignee, availableHours);
                totalAvailableHours = Number((totalAvailableHours + availableHours).toFixed(1));
            }

            // Als er genoeg uren beschikbaar zijn, verplaats het issue
            if (totalAvailableHours >= hours) {
                // Verdeel de uren over de beschikbare medewerkers
                let remainingHours = hours;
                const newSprintHours = new Map(sprintEmployeeHours);

                // Probeer eerst de uren te verdelen over medewerkers met de meeste beschikbare uren
                const sortedAssignees = Array.from(availableHoursPerPerson.entries())
                    .sort((a, b) => b[1] - a[1]);

                for (const [assignee, availableHours] of sortedAssignees) {
                    if (remainingHours > 0 && availableHours > 0) {
                        const hoursToAssign = Number((Math.min(remainingHours, availableHours)).toFixed(1));
                        const currentUsedHours = Number((newSprintHours.get(assignee) || 0).toFixed(1));
                        const sprintCapacity = Number((employeeDataMap.get(assignee)!.hours * 2).toFixed(1));
                        
                        // Controleer of de toewijzing de sprint capaciteit niet overschrijdt
                        if (Number((currentUsedHours + hoursToAssign).toFixed(1)) <= sprintCapacity) {
                            newSprintHours.set(assignee, Number((currentUsedHours + hoursToAssign).toFixed(1)));
                            remainingHours = Number((remainingHours - hoursToAssign).toFixed(1));
                        }
                    }
                }

                // Alleen als alle uren zijn toegewezen, update de sprint uren
                if (remainingHours === 0) {
                    sprintHours.set(targetSprint, newSprintHours);
                    
                    // Update de planning
                    const planningIndex = sprintPlanning.findIndex(p => p.issue.key === issue.key);
                    if (planningIndex !== -1) {
                        sprintPlanning[planningIndex].sprint = targetSprint;
                        issueSprintMap.set(issue.key, targetSprint);
                        foundSprint = true;
                        break;
                    }
                }
            }
        }
    }

    return sprintPlanning;
}

function getSprintName(issue: Issue): string {
    const sprints = issue.fields.customfield_10020;
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

interface WorkLog {
    issueKey: string;
    issueSummary: string;
    author: string;
    timeSpentSeconds: number;
    started: string;
    comment?: string;
    estimatedTime: number;
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
    const subscriptionPlanning = calculatePlanning(subscriptionIssues, googleSheetsData, 'subscription');
    const atlantisPlanning = calculatePlanning(atlantisIssues, googleSheetsData, 'atlantis');

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
                                    <th>Toegewezen aan</th>
                                    <th>Uren</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${subscriptionIssues.map(issue => `
                                    <tr>
                                        <td>${issue.key}</td>
                                        <td>${issue.fields?.summary}</td>
                                        <td>${issue.fields?.status?.name}</td>
                                        <td>${issue.fields?.assignee?.displayName || 'Niet toegewezen'}</td>
                                        <td>${formatTime(issue.fields?.timeestimate)}</td>
                                    </tr>
                                `).join('')}
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
                                    <th>Toegewezen aan</th>
                                    <th>Uren</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${atlantisIssues.map(issue => `
                                    <tr>
                                        <td>${issue.key}</td>
                                        <td>${issue.fields?.summary}</td>
                                        <td>${issue.fields?.status?.name}</td>
                                        <td>${issue.fields?.assignee?.displayName || 'Niet toegewezen'}</td>
                                        <td>${formatTime(issue.fields?.timeestimate)}</td>
                                    </tr>
                                `).join('')}
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
                        ${generateSprintHoursTable(subscriptionPlanning, 'Subscriptions')}
                    </div>
                    <div class="col-md-6">
                        <h3>Atlantis 7</h3>
                        ${generateSprintHoursTable(atlantisPlanning, 'Atlantis')}
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

function generateSprintHoursTable(planning: { issue: Issue; sprint: number }[], projectType: string): string {
    const sprintHoursMap = new Map<number, Map<string, number>>();
    const sprintNames = new Map<number, string>();
    const sprintAssignments = new Map<number, Map<string, Issue[]>>();

    // Verzamel alle unieke sprints en medewerkers
    const uniqueSprints = new Set(planning.map(p => p.sprint));
    const uniqueEmployees = new Set(planning.map(p => p.issue.fields?.assignee?.displayName || 'Niet toegewezen'));

    // Initialiseer de maps voor elke sprint
    uniqueSprints.forEach(sprint => {
        sprintHoursMap.set(sprint, new Map());
        sprintAssignments.set(sprint, new Map());
        uniqueEmployees.forEach(employee => {
            sprintHoursMap.get(sprint)?.set(employee, 0);
            sprintAssignments.get(sprint)?.set(employee, []);
        });
    });

    // Vul de uren en assignments in
    planning.forEach(({ issue, sprint }) => {
        const assignee = issue.fields?.assignee?.displayName || 'Niet toegewezen';
        const hours = Number(((issue.fields?.timeestimate || 0) / 3600).toFixed(1));
        
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

    // Genereer de HTML tabel
    return `
        <h2>Uren per Sprint ${projectType}</h2>
        <table class="table">
            <thead>
                <tr>
                    <th>Sprint</th>
                    <th>Medewerker</th>
                    <th>Gebruikte uren</th>
                    <th>Issues</th>
                </tr>
            </thead>
            <tbody>
                ${Array.from(uniqueSprints).sort((a, b) => a - b).map(sprint => `
                    ${Array.from(uniqueEmployees).map(person => {
                        const hours = sprintHoursMap.get(sprint)?.get(person) || 0;
                        const issues = sprintAssignments.get(sprint)?.get(person) || [];
                        
                        // Haal issues op voor deze sprint en persoon
                        const sprintIssues = planning
                            .filter(p => p.sprint === sprint && p.issue.fields?.assignee?.displayName === person)
                            .map(p => ({
                                key: p.issue.key,
                                hours: Number(((p.issue.fields?.timeestimate || 0) / 3600).toFixed(1))
                            }));

                        return `
                            <tr>
                                <td>Sprint ${sprint}</td>
                                <td>${person}</td>
                                <td>${hours.toFixed(1)}</td>
                                <td>
                                    ${sprintIssues.map(issue => 
                                        `<div><a href="https://deventit.atlassian.net/browse/${issue.key}" target="_blank">${issue.key}</a> (${issue.hours} uur)</div>`
                                    ).join('')}
                                </td>
                            </tr>
                        `;
                    }).join('')}
                `).join('')}
            </tbody>
        </table>
    `;
}

// Planning endpoint
app.get('/api/planning', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const planning = await getPlanning();
        if (!planning) {
            const error = new Error('Geen planning data ontvangen') as any;
            error.statusCode = 404;
            throw error;
        }
        res.json(planning);
    } catch (error: any) {
        console.error(`Error bij ophalen planning: ${JSON.stringify(error)}`);
        next(error);
    }
});

// Worklogs endpoint
app.get('/api/worklogs', async (req, res) => {
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
        const workLogsResponse = await getWorkLogs(startDate as string, endDate as string) as WorkLogsResponse;
        
        // Haal actieve issues op voor de samenvattingen
        const issues = await getActiveIssues();
        
        // Bereken efficiëntie
        const efficiencyTable = calculateEfficiency(issues, workLogsResponse.workLogs, new Date(startDate as string), new Date(endDate as string));
        
        // Groepeer worklogs per medewerker
        const workLogsByEmployee = new Map<string, WorkLog[]>();
        workLogsResponse.workLogs.forEach(log => {
            const logs = workLogsByEmployee.get(log.author) || [];
            logs.push(log);
            workLogsByEmployee.set(log.author, logs);
        });

        // Genereer HTML tabel voor worklogs
        const workLogsTable = `
            <div class="worklogs-container">
                <h3>Worklogs van ${new Date(startDate as string).toLocaleDateString('nl-NL')} tot ${new Date(endDate as string).toLocaleDateString('nl-NL')}</h3>
                <table class="table">
                    <thead>
                        <tr>
                            <th>Medewerker</th>
                            <th>Niet gewerkt (EET-3561)</th>
                            <th>Niet op issues (EET-3560)</th>
                            <th>Ontwikkeling</th>
                            <th>Totaal</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${(() => {
                            let totalNietGewerkt = 0;
                            let totalNietOpIssues = 0;
                            let totalOntwikkeling = 0;
                            let totalTotaal = 0;

                            const rows = Array.from(workLogsByEmployee.entries()).map(([employee, logs]) => {
                                // Groepeer logs per categorie
                                const nietGewerkt = logs.filter(log => log.issueKey === 'EET-3561');
                                const nietOpIssues = logs.filter(log => log.issueKey === 'EET-3560');
                                const ontwikkeling = logs.filter(log => log.issueKey !== 'EET-3561' && log.issueKey !== 'EET-3560');

                                // Bereken totale uren per categorie
                                const nietGewerktUren = nietGewerkt.reduce((sum, log) => sum + log.timeSpentSeconds, 0) / 3600;
                                const nietOpIssuesUren = nietOpIssues.reduce((sum, log) => sum + log.timeSpentSeconds, 0) / 3600;
                                const ontwikkelingUren = ontwikkeling.reduce((sum, log) => sum + log.timeSpentSeconds, 0) / 3600;
                                const rowTotal = Number((nietGewerktUren + nietOpIssuesUren + ontwikkelingUren).toFixed(1));

                                // Update totalen
                                totalNietGewerkt = Number((totalNietGewerkt + nietGewerktUren).toFixed(1));
                                totalNietOpIssues = Number((totalNietOpIssues + nietOpIssuesUren).toFixed(1));
                                totalOntwikkeling = Number((totalOntwikkeling + ontwikkelingUren).toFixed(1));
                                totalTotaal = Number((totalTotaal + rowTotal).toFixed(1));

                                return `
                                    <tr>
                                        <td>${employee}</td>
                                        <td>${nietGewerktUren.toFixed(1)} uur</td>
                                        <td>${nietOpIssuesUren.toFixed(1)} uur</td>
                                        <td>${ontwikkelingUren.toFixed(1)} uur</td>
                                        <td>${rowTotal.toFixed(1)} uur</td>
                                    </tr>
                                `;
                            }).join('');

                            // Voeg totalen rij toe
                            const totalsRow = `
                                <tr class="table-dark">
                                    <td><strong>Totaal</strong></td>
                                    <td><strong>${totalNietGewerkt.toFixed(1)} uur</strong></td>
                                    <td><strong>${totalNietOpIssues.toFixed(1)} uur</strong></td>
                                    <td><strong>${totalOntwikkeling.toFixed(1)} uur</strong></td>
                                    <td><strong>${totalTotaal.toFixed(1)} uur</strong></td>
                                </tr>
                            `;

                            return rows + totalsRow;
                        })()}
                    </tbody>
                </table>
                ${efficiencyTable}
            </div>
        `;

        res.send(workLogsTable);
    } catch (error) {
        console.error('Error fetching worklogs:', error);
        res.status(500).send(`
            <div class="alert alert-danger">
                Er is een fout opgetreden bij het ophalen van de worklogs.
            </div>
        `);
    }
});

// Error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error(`Server error: ${err}`);
    res.status(500).json({ error: 'Er is een interne serverfout opgetreden' });
});

// Unhandled promise rejection handler
process.on('unhandledRejection', (reason: unknown) => {
    console.error(`Unhandled Rejection: ${reason}`);
    // Voorkom dat de server crasht bij een unhandled rejection
    // In plaats daarvan loggen we de error en gaan we door
});

// Uncaught exception handler
process.on('uncaughtException', (error: Error) => {
    console.error(`Unhandled Exception: ${error.message}`);
    // Bij een uncaught exception sluiten we de server netjes af
    process.exit(1);
});

// Start de server in een try-catch block
try {
    app.listen(port, () => {
        console.log(`Server draait op poort ${port}`);
    });
} catch (error) {
    console.error(`Error bij starten van server: ${error}`);
    process.exit(1);
} 