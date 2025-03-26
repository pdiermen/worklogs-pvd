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
        console.log('Start ophalen van data...');
        
        // Haal data op
        console.log('Ophalen van Jira issues...');
        const allIssues = await getActiveIssues();
        console.log(`Aantal Jira issues gevonden: ${allIssues.length}`);
        console.log('Voorbeeld issue:', allIssues[0]);
        
        console.log('Ophalen van Google Sheets data...');
        const googleSheetsData = await getGoogleSheetsData();
        console.log(`Google Sheets data gevonden: ${googleSheetsData ? 'Ja' : 'Nee'}`);
        if (googleSheetsData) {
            console.log('Aantal rijen in Google Sheets:', googleSheetsData.length);
        }
        
        // Splits issues in projecten
        const subscriptionIssues = allIssues.filter(issue => 
            issue.fields.parent?.key === 'EET-5236' || issue.fields.parent?.key === 'EET-6096'
        );
        const atlantisIssues = allIssues.filter(issue => 
            issue.fields.parent?.key !== 'EET-5236' && issue.fields.parent?.key !== 'EET-6096'
        );
        
        console.log(`Aantal subscription issues: ${subscriptionIssues.length}`);
        console.log(`Aantal atlantis issues: ${atlantisIssues.length}`);
        
        // Debug informatie voor parent issues
        const subscriptionParentIssues = new Set(subscriptionIssues.map(issue => issue.fields.parent?.key));
        console.log('Parent issues van Subscriptions project:', Array.from(subscriptionParentIssues));
        
        // Toon voorbeeld issues per parent
        subscriptionParentIssues.forEach(parentKey => {
            const issuesForParent = subscriptionIssues.filter(issue => issue.fields.parent?.key === parentKey);
            console.log(`\nIssues voor parent ${parentKey}:`);
            issuesForParent.forEach(issue => {
                console.log(`- ${issue.key}: ${issue.fields.summary}`);
            });
        });
        
        // Bereken statistieken per persoon
        console.log('Bereken statistieken per persoon...');
        const personStats = getPersonStats(allIssues);
        console.log('Person stats:', personStats);
        
        // Bereken planning met sprints voor beide projecten
        console.log('Bereken planning...');
        const subscriptionPlanning = getPlanning(subscriptionIssues, googleSheetsData, 'subscription');
        const atlantisPlanning = getPlanning(atlantisIssues, googleSheetsData, 'atlantis');
        
        // Bereken uren per sprint voor beide projecten
        console.log('Bereken uren per sprint...');
        const subscriptionSprintHours = getSprintHours(subscriptionPlanning, 'subscription');
        const atlantisSprintHours = getSprintHours(atlantisPlanning, 'atlantis');

        console.log('Start genereren HTML...');
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
                    .debug-info { background-color: #f8f8f8; padding: 10px; margin: 10px 0; }
                </style>
            </head>
            <body>
                <h1>Jira Issues</h1>
                
                <div class="debug-info">
                    <h3>Debug Informatie:</h3>
                    <p>Aantal issues: ${allIssues.length}</p>
                    <p>Aantal subscription issues: ${subscriptionIssues.length}</p>
                    <p>Aantal atlantis issues: ${atlantisIssues.length}</p>
                    <p>Google Sheets data aanwezig: ${googleSheetsData ? 'Ja' : 'Nee'}</p>
                </div>
                
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
                        <th>Project</th>
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

                <h2>Uren per Sprint Atlantis 7</h2>
                <table>
                    <tr>
                        <th>Sprint</th>
                        <th>Persoon</th>
                        <th>Uren</th>
                        <th>Uren beschikbaar</th>
                        <th>Uren over</th>
                    </tr>
                    ${atlantisSprintHours.map(({ sprint, person, hours }) => {
                        const employeeHours = googleSheetsData ? parseFloat(googleSheetsData.slice(1).find(row => row[2] === person)?.[6] || '0') : 0;
                        const sprintCapacity = employeeHours * 2;
                        const subscriptionHours = subscriptionSprintHours.find(h => h.sprint === sprint && h.person === person)?.hours || 0;
                        const availableHours = Math.max(0, sprintCapacity - subscriptionHours);
                        const remainingHours = Math.max(0, availableHours - hours);
                        return `
                        <tr>
                            <td>${sprint}</td>
                            <td>${person}</td>
                            <td>${hours.toFixed(1)}</td>
                            <td>${availableHours.toFixed(1)}</td>
                            <td>${remainingHours.toFixed(1)}</td>
                        </tr>
                    `}).join('')}
                </table>

                <h2>Uren per Sprint Subscriptions</h2>
                <table>
                    <tr>
                        <th>Sprint</th>
                        <th>Persoon</th>
                        <th>Uren</th>
                        <th>Uren beschikbaar</th>
                        <th>Uren over</th>
                    </tr>
                    ${subscriptionSprintHours.map(({ sprint, person, hours }) => {
                        const employeeHours = googleSheetsData ? parseFloat(googleSheetsData.slice(1).find(row => row[2] === person)?.[6] || '0') : 0;
                        const sprintCapacity = employeeHours * 2;
                        const atlantisHours = atlantisSprintHours.find(h => h.sprint === sprint && h.person === person)?.hours || 0;
                        const availableHours = Math.max(0, sprintCapacity - atlantisHours);
                        const remainingHours = Math.max(0, availableHours - hours);
                        return `
                        <tr>
                            <td>${sprint}</td>
                            <td>${person}</td>
                            <td>${hours.toFixed(1)}</td>
                            <td>${availableHours.toFixed(1)}</td>
                            <td>${remainingHours.toFixed(1)}</td>
                        </tr>
                    `}).join('')}
                </table>

                <h2>Totaal uren per Sprint Atlantis 7</h2>
                <table>
                    <tr>
                        <th>Sprint</th>
                        <th>Totaal beschikbare uren</th>
                        <th>Totaal ingeplande uren</th>
                        <th>Uren over</th>
                    </tr>
                    ${Array.from({ length: 10 }, (_, i) => i + 1).map(sprint => {
                        const totalAvailableHours = getAvailableHoursForProject(googleSheetsData, 'Atlantis 7');
                        const atlantisHours = atlantisSprintHours
                            .filter(h => h.sprint === sprint)
                            .reduce((sum, h) => sum + h.hours, 0);
                        const remainingHours = Math.max(0, totalAvailableHours - atlantisHours);

                        return `
                        <tr>
                            <td>${sprint}</td>
                            <td>${totalAvailableHours.toFixed(1)}</td>
                            <td>${atlantisHours.toFixed(1)}</td>
                            <td>${remainingHours.toFixed(1)}</td>
                        </tr>
                    `}).join('')}
                </table>

                <h2>Totaal uren per Sprint Subscriptions</h2>
                <table>
                    <tr>
                        <th>Sprint</th>
                        <th>Totaal beschikbare uren</th>
                        <th>Totaal ingeplande uren</th>
                        <th>Uren over</th>
                    </tr>
                    ${Array.from({ length: 10 }, (_, i) => i + 1).map(sprint => {
                        const totalAvailableHours = getAvailableHoursForProject(googleSheetsData, 'Subscriptions');
                        const subscriptionHours = subscriptionSprintHours
                            .filter(h => h.sprint === sprint)
                            .reduce((sum, h) => sum + h.hours, 0);
                        const remainingHours = Math.max(0, totalAvailableHours - subscriptionHours);

                        return `
                        <tr>
                            <td>${sprint}</td>
                            <td>${totalAvailableHours.toFixed(1)}</td>
                            <td>${subscriptionHours.toFixed(1)}</td>
                            <td>${remainingHours.toFixed(1)}</td>
                        </tr>
                    `}).join('')}
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

                <div class="nav-link">
                    <a href="/worklogs">Bekijk Work Logging</a>
                </div>
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

function getPlanning(issues: Issue[], googleSheetsData: string[][] | null, projectType: 'atlantis' | 'subscription'): { issue: Issue; sprint: number }[] {
    console.log(`Start getPlanning functie voor project ${projectType}...`);
    
    // Maak een map van effectieve uren en projecten per medewerker
    const employeeDataMap = new Map<string, { hours: number; projects: string[] }>();
    if (googleSheetsData) {
        googleSheetsData.slice(1).forEach(row => {
            const name = row[2]; // Naam is in kolom C
            const effectiveHours = parseFloat(row[6]) || 0; // Effectieve uren is in kolom G
            const projects = (row[7] || '').split(',').map(p => p.trim()); // Projecten zijn in kolom H
            employeeDataMap.set(name, { hours: effectiveHours, projects });
            console.log(`Medewerker ${name} heeft ${effectiveHours} effectieve uren per week en werkt op projecten: ${projects.join(', ')}`);
        });
    }

    // Filter issues op basis van projecten waar medewerkers op werken
    const filteredIssues = issues.filter(issue => {
        const assignee = issue.fields.assignee?.displayName;
        if (!assignee) return false;
        
        const employeeData = employeeDataMap.get(assignee);
        if (!employeeData) return false;

        // Controleer of de medewerker op het juiste project werkt
        return employeeData.projects.includes(projectType === 'atlantis' ? 'Atlantis 7' : 'Subscriptions');
    });

    console.log(`Aantal gefilterde issues voor ${projectType}: ${filteredIssues.length}`);

    // Sorteer issues op prioriteit (Highest -> High -> Medium -> Low)
    const priorityOrder = ['Highest', 'High', 'Medium', 'Low'];
    
    // Bereid issues voor met prioriteit en opvolgers
    const issuesWithPriority = filteredIssues.map(issue => ({
        issue,
        priority: priorityOrder.indexOf(issue.fields.priority.name),
        hasSuccessors: getSuccessors(issue).length > 0,
        hours: (issue.fields.timeestimate || 0) / 3600, // Converteer naar uren
        isActive: issue.fields.status.name === 'Open' || issue.fields.status.name === 'In review',
        isWaiting: issue.fields.status.name === 'Waiting',
        predecessors: getPredecessors(issue),
        isPeterIssue: issue.fields.assignee?.displayName === 'Peter van Diermen'
    }));

    console.log(`Aantal issues om te plannen: ${issuesWithPriority.length}`);

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
        const assignee = issue.fields.assignee?.displayName || 'Niet toegewezen';
        const employeeHours = employeeDataMap.get(assignee)?.hours || 0;
        const sprintCapacity = employeeHours * 2; // 2 weken per sprint

        console.log(`\nBezig met plannen van issue ${issue.key} (${hours} uren) voor ${assignee} - Status: ${issue.fields.status.name}`);
        console.log(`Beschikbare uren per sprint voor ${assignee}: ${sprintCapacity}`);

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
                console.log(`Issue ${issue.key} is Waiting en wordt gepland in sprint ${assignedSprint} (na voorgangers)`);
            }
        }

        // Controleer eerst de huidige sprint
        const currentSprintHours = sprintHours.get(assignedSprint)!;
        const currentEmployeeHours = currentSprintHours.get(assignee) || 0;

        console.log(`Huidige sprint (${assignedSprint}): ${currentEmployeeHours} uren gebruikt van ${sprintCapacity}`);

        // Als er nog tijd over is in de huidige sprint, plaats het issue daar
        if (currentEmployeeHours < sprintCapacity) {
            // Update sprint uren
            currentSprintHours.set(assignee, currentEmployeeHours + hours);
            sprintHours.set(assignedSprint, currentSprintHours);
            foundSprint = true;
        } else {
            // Als de issue niet in de huidige sprint past, zoek de volgende beschikbare sprint
            assignedSprint++;
            while (assignedSprint <= maxSprints) {
                const sprintEmployeeHours = sprintHours.get(assignedSprint) || new Map<string, number>();
                const employeeHoursInSprint = sprintEmployeeHours.get(assignee) || 0;

                console.log(`Sprint ${assignedSprint}: ${employeeHoursInSprint} uren gebruikt van ${sprintCapacity}`);

                // Als er nog tijd over is in deze sprint, plaats het issue daar
                if (employeeHoursInSprint < sprintCapacity) {
                    // Update sprint uren
                    sprintEmployeeHours.set(assignee, employeeHoursInSprint + hours);
                    sprintHours.set(assignedSprint, sprintEmployeeHours);
                    foundSprint = true;
                    break;
                }

                assignedSprint++;
            }
        }

        if (!foundSprint) {
            console.log(`WAARSCHUWING: Issue ${issue.key} past niet binnen ${maxSprints} sprints voor ${assignee}`);
            // Toewijzen aan laatste sprint als fallback
            assignedSprint = maxSprints;
        }

        sprintPlanning.push({ issue, sprint: assignedSprint });
        issueSprintMap.set(issue.key, assignedSprint);
        console.log(`Issue ${issue.key} toegewezen aan sprint ${assignedSprint}`);
    }

    // Herverdeel Peter's issues over de beschikbare uren
    console.log('\nStart herverdelen van Peter\'s issues...');
    const peterIssues = sprintPlanning.filter(({ issue, sprint }) => 
        issue.fields.assignee?.displayName === 'Peter van Diermen'
    );
    
    console.log(`Aantal Peter's issues om te herverdelen: ${peterIssues.length}`);
    
    for (const { issue, sprint } of peterIssues) {
        const hours = (issue.fields.timeestimate || 0) / 3600;
        console.log(`\nBezig met herverdelen van Peter's issue ${issue.key} (${hours} uren)`);

        // Zoek een sprint met voldoende beschikbare uren
        let foundSprint = false;
        for (let targetSprint = 1; targetSprint <= maxSprints; targetSprint++) {
            const sprintEmployeeHours = sprintHours.get(targetSprint) || new Map<string, number>();
            let totalAvailableHours = 0;

            // Bereken totale beschikbare uren in deze sprint
            for (const [assignee, employeeData] of employeeDataMap.entries()) {
                if (assignee === 'Peter van Diermen') continue;
                const sprintCapacity = employeeData.hours * 2;
                const usedHours = sprintEmployeeHours.get(assignee) || 0;
                const availableHours = sprintCapacity - usedHours;
                totalAvailableHours += availableHours;
                console.log(`Sprint ${targetSprint}: ${assignee} heeft ${availableHours} uren beschikbaar (${usedHours} gebruikt van ${sprintCapacity})`);
            }

            console.log(`Sprint ${targetSprint}: ${totalAvailableHours} uren beschikbaar in totaal voor issue ${issue.key} (${hours} uren nodig)`);

            // Als er genoeg uren beschikbaar zijn, verplaats het issue
            if (totalAvailableHours >= hours) {
                // Verdeel de uren over de beschikbare medewerkers
                let remainingHours = hours;
                for (const [assignee, employeeData] of employeeDataMap.entries()) {
                    if (assignee === 'Peter van Diermen') continue;
                    const sprintCapacity = employeeData.hours * 2;
                    const usedHours = sprintEmployeeHours.get(assignee) || 0;
                    const availableHours = sprintCapacity - usedHours;

                    if (remainingHours > 0 && availableHours > 0) {
                        const hoursToAssign = Math.min(remainingHours, availableHours);
                        sprintEmployeeHours.set(assignee, usedHours + hoursToAssign);
                        remainingHours -= hoursToAssign;
                        console.log(`Toegewezen ${hoursToAssign} uren aan ${assignee} in sprint ${targetSprint} (${remainingHours} uren over)`);
                    }
                }

                sprintHours.set(targetSprint, sprintEmployeeHours);
                
                // Update de planning
                const planningIndex = sprintPlanning.findIndex(p => p.issue.key === issue.key);
                if (planningIndex !== -1) {
                    sprintPlanning[planningIndex].sprint = targetSprint;
                    issueSprintMap.set(issue.key, targetSprint);
                    console.log(`Peter's issue ${issue.key} verplaatst naar sprint ${targetSprint}`);
                    foundSprint = true;
                    break;
                }
            }
        }

        if (!foundSprint) {
            console.log(`WAARSCHUWING: Kon Peter's issue ${issue.key} niet herverdelen over de sprints`);
        }
    }

    console.log('Planning voltooid');
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

function getSprintHours(sprintPlanning: { issue: Issue; sprint: number }[], projectType: 'atlantis' | 'subscription'): { sprint: number; person: string; hours: number }[] {
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

function getAvailableHoursForProject(googleSheetsData: string[][] | null, projectName: string): number {
    if (!googleSheetsData) return 0;
    return googleSheetsData.slice(1).reduce((sum, row) => {
        const projects = (row[7] || '').split(',').map(p => p.trim());
        if (projects.includes(projectName)) {
            const effectiveHours = parseFloat(row[6]) || 0;
            return sum + (effectiveHours * 2); // 2 weken per sprint
        }
        return sum;
    }, 0);
}

app.listen(port, () => {
    console.log(`Server draait op http://localhost:${port}`);
}); 