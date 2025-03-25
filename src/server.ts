import express from 'express';
import { getActiveIssues, getWorkLogs } from './jira';
import { Issue, IssueLink } from './types';
import * as dotenv from 'dotenv';
import path from 'path';
import { google } from 'googleapis';
import { JWT } from 'google-auth-library';

// Laad .env.local bestand
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const app = express();
const port = 3000;
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

// Google Sheets configuratie
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
const auth = new JWT({
    email: process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
    key: process.env.GOOGLE_SHEETS_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    scopes: SCOPES
});

const sheets = google.sheets({ version: 'v4', auth });

async function getGoogleSheetsData(): Promise<string[][] | null> {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Employees!A:H'
        });
        return response.data.values as string[][];
    } catch (error) {
        console.error('Error reading Google Sheets:', error);
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

app.get('/worklogs', async (req, res) => {
    try {
        const startDate = req.query.startDate as string;
        const endDate = req.query.endDate as string;
        
        if (!startDate || !endDate) {
            const html = `
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Work Logging</title>
                    <style>
                        body { font-family: Arial, sans-serif; margin: 20px; }
                        table { border-collapse: collapse; width: 100%; margin-bottom: 20px; }
                        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
                        th { background-color: #f2f2f2; }
                        .date-filter { margin: 20px 0; }
                        .date-filter input { margin: 0 10px; }
                        .date-filter button { margin-left: 10px; }
                        .nav-link { margin: 10px 0; }
                    </style>
                </head>
                <body>
                    <h1>Work Logging</h1>
                    
                    <div class="nav-link">
                        <a href="/">Terug naar Issues</a>
                    </div>
                    
                    <div class="date-filter">
                        <form method="get">
                            <label>Vanaf:</label>
                            <input type="date" name="startDate" required>
                            <label>Tot:</label>
                            <input type="date" name="endDate" required>
                            <button type="submit">Uitvoeren</button>
                        </form>
                    </div>
                </body>
                </html>
            `;
            res.send(html);
            return;
        }

        const workLogs = await getWorkLogs(startDate, endDate);
        const workLogStats = new Map<string, { nietGewerkt: number; overigeNietDeclarabel: number; productontwikkeling: number }>();
        
        workLogs.forEach(log => {
            const author = log.author;
            const currentStats = workLogStats.get(author) || { nietGewerkt: 0, overigeNietDeclarabel: 0, productontwikkeling: 0 };
            
            if (log.issueKey === 'EET-3561') {
                currentStats.nietGewerkt += log.timeSpentSeconds;
            } else if (log.issueKey === 'EET-3560') {
                currentStats.overigeNietDeclarabel += log.timeSpentSeconds;
            } else {
                currentStats.productontwikkeling += log.timeSpentSeconds;
            }
            
            workLogStats.set(author, currentStats);
        });

        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <title>Work Logging</title>
                <style>
                    body { font-family: Arial, sans-serif; margin: 20px; }
                    table { border-collapse: collapse; width: 100%; margin-bottom: 20px; }
                    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
                    th { background-color: #f2f2f2; }
                    .date-filter { margin: 20px 0; }
                    .date-filter input { margin: 0 10px; }
                    .date-filter button { margin-left: 10px; }
                    .nav-link { margin: 10px 0; }
                </style>
            </head>
            <body>
                <h1>Work Logging</h1>
                
                <div class="nav-link">
                    <a href="/">Terug naar Issues</a>
                </div>
                
                <div class="date-filter">
                    <form method="get">
                        <label>Vanaf:</label>
                        <input type="date" name="startDate" value="${startDate}" required>
                        <label>Tot:</label>
                        <input type="date" name="endDate" value="${endDate}" required>
                        <button type="submit">Uitvoeren</button>
                    </form>
                </div>
                
                <table>
                    <tr>
                        <th>Medewerker</th>
                        <th>Niet gewerkt</th>
                        <th>Overige niet-declarabel</th>
                        <th>Productontwikkeling</th>
                    </tr>
                    ${Array.from(workLogStats.entries()).map(([author, stats]) => `
                        <tr>
                            <td>${author}</td>
                            <td>${formatTime(stats.nietGewerkt)}</td>
                            <td>${formatTime(stats.overigeNietDeclarabel)}</td>
                            <td>${formatTime(stats.productontwikkeling)}</td>
                        </tr>
                    `).join('')}
                </table>
            </body>
            </html>
        `;

        res.send(html);
    } catch (error) {
        console.error('Error fetching work logs:', error);
        res.status(500).send('Er is een fout opgetreden bij het ophalen van de work logs.');
    }
});

app.get('/', async (req, res) => {
    try {
        // Haal data op
        const allIssues = await getActiveIssues();
        const googleSheetsData = await getGoogleSheetsData();
        
        // Splits issues in projecten
        const subscriptionIssues = allIssues.filter(issue => 
            issue.fields.parent?.key === 'EET-5236' || issue.fields.parent?.key === 'EET-6096'
        );
        const atlantisIssues = allIssues.filter(issue => 
            issue.fields.parent?.key !== 'EET-5236' && issue.fields.parent?.key !== 'EET-6096'
        );
        
        // Bereken statistieken per persoon
        const personStats = getPersonStats(allIssues);
        
        // Bereken planning met sprints voor beide projecten
        const subscriptionPlanning = getPlanning(subscriptionIssues, googleSheetsData);
        const atlantisPlanning = getPlanning(atlantisIssues, googleSheetsData);
        
        // Bereken uren per sprint voor beide projecten
        const subscriptionSprintHours = getSprintHours(subscriptionPlanning);
        const atlantisSprintHours = getSprintHours(atlantisPlanning);

        // Stuur de volledige HTML
        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <title>Jira Issues</title>
                <style>
                    body { font-family: Arial, sans-serif; margin: 20px; }
                    table { border-collapse: collapse; width: 100%; margin-bottom: 20px; }
                    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
                    th { background-color: #f2f2f2; }
                    .relationship { margin: 5px 0; }
                    .nav-link { margin: 10px 0; }
                </style>
            </head>
            <body>
                <h1>Jira Issues</h1>
                
                <div class="nav-link">
                    <a href="/worklogs">Bekijk Work Logging</a>
                </div>
                
                <h2>Alle Issues</h2>
                <table>
                    <tr>
                        <th>Issue Key</th>
                        <th>Samenvatting</th>
                        <th>Status</th>
                        <th>Toegewezen aan</th>
                        <th>Estimated (uren)</th>
                        <th>Remaining (uren)</th>
                        <th>Voorgangers</th>
                        <th>Opvolgers</th>
                        <th>Parent</th>
                    </tr>
                    ${allIssues.map(issue => `
                        <tr>
                            <td>${issue.key}</td>
                            <td>${issue.fields.summary}</td>
                            <td>${issue.fields.status.name}</td>
                            <td>${issue.fields.assignee?.displayName || '-'}</td>
                            <td>${formatTime(issue.fields.timeoriginalestimate)}</td>
                            <td>${formatTime(issue.fields.timeestimate)}</td>
                            <td>${getPredecessors(issue).join(', ') || '-'}</td>
                            <td>${getSuccessors(issue).join(', ') || '-'}</td>
                            <td>${issue.fields.parent?.fields?.summary || '-'}</td>
                        </tr>
                    `).join('')}
                </table>
                <h2>Planning Subscriptions</h2>
                <p>Volgorde van uitvoering (rekening houdend met voorgangers, prioriteit en beschikbare uren):</p>
                <table>
                    <tr>
                        <th>Sprint</th>
                        <th>Issue</th>
                        <th>Omschrijving</th>
                        <th>Prioriteit</th>
                        <th>Status</th>
                        <th>Toegewezen aan</th>
                        <th>Opvolgers</th>
                        <th>Remaining (uren)</th>
                    </tr>
                    ${subscriptionPlanning
                        .sort((a, b) => {
                            if (a.sprint !== b.sprint) return a.sprint - b.sprint;
                            const successorsA = getSuccessors(a.issue).length;
                            const successorsB = getSuccessors(b.issue).length;
                            if (successorsA !== successorsB) return successorsB - successorsA;
                            const priorityOrder = ['Highest', 'High', 'Medium', 'Low'];
                            const priorityA = priorityOrder.indexOf(a.issue.fields.priority.name);
                            const priorityB = priorityOrder.indexOf(b.issue.fields.priority.name);
                            if (priorityA !== priorityB) return priorityA - priorityB;
                            return a.issue.key.localeCompare(b.issue.key);
                        })
                        .map(({ issue, sprint }) => `
                        <tr>
                            <td>${sprint}</td>
                            <td>${issue.key}</td>
                            <td>${issue.fields.summary}</td>
                            <td>${issue.fields.priority.name}</td>
                            <td>${issue.fields.status.name}</td>
                            <td>${issue.fields.assignee?.displayName || '-'}</td>
                            <td>${getSuccessors(issue).join(', ') || '-'}</td>
                            <td>${formatTime(issue.fields.timeestimate)}</td>
                        </tr>
                    `).join('')}
                </table>
                <h2>Planning Atlantis 7</h2>
                <p>Volgorde van uitvoering (rekening houdend met voorgangers, prioriteit en beschikbare uren):</p>
                <table>
                    <tr>
                        <th>Sprint</th>
                        <th>Issue</th>
                        <th>Omschrijving</th>
                        <th>Prioriteit</th>
                        <th>Status</th>
                        <th>Toegewezen aan</th>
                        <th>Opvolgers</th>
                        <th>Remaining (uren)</th>
                    </tr>
                    ${atlantisPlanning
                        .sort((a, b) => {
                            if (a.sprint !== b.sprint) return a.sprint - b.sprint;
                            const successorsA = getSuccessors(a.issue).length;
                            const successorsB = getSuccessors(b.issue).length;
                            if (successorsA !== successorsB) return successorsB - successorsA;
                            const priorityOrder = ['Highest', 'High', 'Medium', 'Low'];
                            const priorityA = priorityOrder.indexOf(a.issue.fields.priority.name);
                            const priorityB = priorityOrder.indexOf(b.issue.fields.priority.name);
                            if (priorityA !== priorityB) return priorityA - priorityB;
                            return a.issue.key.localeCompare(b.issue.key);
                        })
                        .map(({ issue, sprint }) => `
                        <tr>
                            <td>${sprint}</td>
                            <td>${issue.key}</td>
                            <td>${issue.fields.summary}</td>
                            <td>${issue.fields.priority.name}</td>
                            <td>${issue.fields.status.name}</td>
                            <td>${issue.fields.assignee?.displayName || '-'}</td>
                            <td>${getSuccessors(issue).join(', ') || '-'}</td>
                            <td>${formatTime(issue.fields.timeestimate)}</td>
                        </tr>
                    `).join('')}
                </table>
                <h2>Uren per Sprint Subscriptions</h2>
                <table>
                    <tr>
                        <th>Sprint</th>
                        <th>Persoon</th>
                        <th>Uren</th>
                    </tr>
                    ${subscriptionSprintHours.map(({ sprint, person, hours }) => `
                        <tr>
                            <td>${sprint}</td>
                            <td>${person}</td>
                            <td>${hours.toFixed(1)}</td>
                        </tr>
                    `).join('')}
                </table>
                <h2>Uren per Sprint Atlantis 7</h2>
                <table>
                    <tr>
                        <th>Sprint</th>
                        <th>Persoon</th>
                        <th>Uren</th>
                    </tr>
                    ${atlantisSprintHours.map(({ sprint, person, hours }) => `
                        <tr>
                            <td>${sprint}</td>
                            <td>${person}</td>
                            <td>${hours.toFixed(1)}</td>
                        </tr>
                    `).join('')}
                </table>
                <h2>Overzicht per persoon</h2>
                <table>
                    <tr>
                        <th>Naam</th>
                        <th>Aantal issues</th>
                        <th>Remaining time (uren)</th>
                    </tr>
                    ${personStats.map(stat => `
                        <tr>
                            <td>${stat.name}</td>
                            <td>${stat.issueCount}</td>
                            <td>${formatTime(stat.totalRemainingTime)}</td>
                        </tr>
                    `).join('')}
                </table>
                ${googleSheetsData ? `
                <h2>Medewerkers</h2>
                <table>
                    <tr>
                        <th>Organisatie</th>
                        <th>ID</th>
                        <th>Naam</th>
                        <th>Beschikbare uren</th>
                        <th>Overhead</th>
                        <th>Efficiëntie</th>
                        <th>Effectieve uren</th>
                        <th>Vrije dagen</th>
                    </tr>
                    ${googleSheetsData.slice(1).map(row => `
                        <tr>
                            <td>${row[0] || '-'}</td>
                            <td>${row[1] || '-'}</td>
                            <td>${row[2] || '-'}</td>
                            <td>${row[3] || '-'}</td>
                            <td>${row[4] || '-'}</td>
                            <td>${row[5] || '-'}</td>
                            <td>${row[6] || '-'}</td>
                            <td>${row[7] || '-'}</td>
                        </tr>
                    `).join('')}
                </table>
                ` : ''}
            </body>
            </html>
        `;

        res.send(html);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).send('Er is een fout opgetreden bij het ophalen van de issues.');
    }
});

function getPredecessors(issue: Issue): string[] {
    if (!issue.fields.issuelinks) return [];
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
    if (!issue.fields.issuelinks) return [];
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
    const hours = (seconds / 3600).toFixed(1);
    return hours;
}

function getPlanning(issues: Issue[], googleSheetsData: string[][] | null): { issue: Issue; sprint: number }[] {
    // Maak een map van opvolgers voor snelle lookup
    const successorsMap = new Map<string, Set<string>>();
    issues.forEach(issue => {
        const successors = getSuccessors(issue);
        if (successors.length > 0) {
            successorsMap.set(issue.key, new Set(successors));
        }
    });

    // Maak een map van effectieve uren per medewerker
    const employeeHoursMap = new Map<string, number>();
    if (googleSheetsData) {
        googleSheetsData.slice(1).forEach(row => {
            const name = row[2]; // Naam is in kolom C
            const effectiveHours = parseFloat(row[6]) || 0; // Effectieve uren is in kolom G
            employeeHoursMap.set(name, effectiveHours);
        });
    }

    // Sorteer issues op prioriteit (Highest -> High -> Medium -> Low)
    const priorityOrder = ['Highest', 'High', 'Medium', 'Low'];
    
    // Scheid issues in twee groepen: met en zonder opvolgers
    const issuesWithSuccessors = issues.filter(issue => successorsMap.has(issue.key));
    const issuesWithoutSuccessors = issues.filter(issue => !successorsMap.has(issue.key));

    // Sorteer beide groepen op prioriteit
    const sortedIssuesWithSuccessors = [...issuesWithSuccessors].sort((a, b) => {
        const priorityA = priorityOrder.indexOf(a.fields.priority.name);
        const priorityB = priorityOrder.indexOf(b.fields.priority.name);
        return priorityA - priorityB;
    });

    const sortedIssuesWithoutSuccessors = [...issuesWithoutSuccessors].sort((a, b) => {
        const priorityA = priorityOrder.indexOf(a.fields.priority.name);
        const priorityB = priorityOrder.indexOf(b.fields.priority.name);
        return priorityA - priorityB;
    });

    // Voeg eerst alle issues met opvolgers toe
    const order = [...sortedIssuesWithSuccessors];

    // Voeg daarna alle issues zonder opvolgers toe
    order.push(...sortedIssuesWithoutSuccessors);

    // Verdeel issues over sprints
    const sprintPlanning: { issue: Issue; sprint: number }[] = [];
    const sprintHours = new Map<number, Map<string, number>>(); // sprint -> medewerker -> uren
    let currentSprint = 1;

    order.forEach(issue => {
        const assignee = issue.fields.assignee?.displayName || 'Niet toegewezen';
        const issueHours = (issue.fields.timeestimate || 0) / 3600; // Converteer naar uren
        const employeeHours = employeeHoursMap.get(assignee) || 0;
        const sprintCapacity = employeeHours * 2; // 2 weken per sprint

        // Zoek de eerste sprint waar deze issue past
        let assignedSprint = currentSprint;
        while (true) {
            const sprintEmployeeHours = sprintHours.get(assignedSprint) || new Map<string, number>();
            const currentEmployeeHours = sprintEmployeeHours.get(assignee) || 0;

            if (currentEmployeeHours + issueHours <= sprintCapacity) {
                // Update sprint uren
                sprintEmployeeHours.set(assignee, currentEmployeeHours + issueHours);
                sprintHours.set(assignedSprint, sprintEmployeeHours);
                break;
            }

            assignedSprint++;
        }

        sprintPlanning.push({ issue, sprint: assignedSprint });
    });

    return sprintPlanning;
}

function getSprintName(issue: Issue): string {
    if (!issue.fields.customfield_10020 || issue.fields.customfield_10020.length === 0) {
        return '-';
    }
    // Neem de eerste actieve sprint
    const activeSprint = issue.fields.customfield_10020.find(sprint => sprint.state === 'active');
    if (activeSprint) {
        return activeSprint.name;
    }
    // Als er geen actieve sprint is, neem de eerste sprint
    return issue.fields.customfield_10020[0].name;
}

function getPersonStats(issues: Issue[]): { name: string; issueCount: number; totalRemainingTime: number }[] {
    const statsMap = new Map<string, { issueCount: number; totalRemainingTime: number }>();
    
    issues.forEach(issue => {
        const assignee = issue.fields.assignee?.displayName || 'Niet toegewezen';
        const currentStats = statsMap.get(assignee) || { issueCount: 0, totalRemainingTime: 0 };
        
        statsMap.set(assignee, {
            issueCount: currentStats.issueCount + 1,
            totalRemainingTime: currentStats.totalRemainingTime + (issue.fields.timeestimate || 0)
        });
    });

    return Array.from(statsMap.entries()).map(([name, stats]) => ({
        name,
        issueCount: stats.issueCount,
        totalRemainingTime: stats.totalRemainingTime
    }));
}

function getSprintHours(sprintPlanning: { issue: Issue; sprint: number }[]): { sprint: number; person: string; hours: number }[] {
    const sprintHoursMap = new Map<number, Map<string, number>>();
    
    sprintPlanning.forEach(({ issue, sprint }) => {
        const assignee = issue.fields.assignee?.displayName || 'Niet toegewezen';
        const hours = (issue.fields.timeestimate || 0) / 3600;
        
        const sprintMap = sprintHoursMap.get(sprint) || new Map<string, number>();
        const currentHours = sprintMap.get(assignee) || 0;
        sprintMap.set(assignee, currentHours + hours);
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

app.listen(port, () => {
    console.log(`Server draait op http://localhost:${port}`);
}); 