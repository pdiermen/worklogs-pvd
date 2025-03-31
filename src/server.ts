import express, { Request, Response, RequestHandler } from 'express';
import cors from 'cors';
import { getActiveIssues, getWorkLogs, getPlanning } from './jira';
import { Issue, IssueLink } from './types';
import * as dotenv from 'dotenv';
import path from 'path';
import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import { logger } from './utils/logger';

// Laad .env.local bestand
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const app = express();
const port = process.env.PORT || 3001;
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

// Google Sheets configuratie
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
const auth = new JWT({
    email: process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
    key: process.env.GOOGLE_SHEETS_PRIVATE_KEY?.replace(/\\n/g, '\n'),
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
        logger.error(`Error reading Google Sheets: ${error}`);
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
        logger.error(`Error fetching work logs: ${error}`);
        res.status(500).send('Er is een fout opgetreden bij het ophalen van de work logs.');
    }
});

app.get('/', async (req, res) => {
    try {
        logger.log('Start ophalen van data...');
        
        // Haal issues op
        const issues = await getActiveIssues();
        logger.log(`Aantal issues gevonden: ${issues.length}`);

        // Haal Google Sheets data op
        const googleSheetsData = await getGoogleSheetsData();
        logger.log('Google Sheets data opgehaald');

        // Haal worklogs op voor de laatste 30 dagen
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 30);
        const workLogs = await getWorkLogs(
            startDate.toISOString().split('T')[0],
            endDate.toISOString().split('T')[0]
        );
        logger.log(`Aantal worklogs gevonden: ${workLogs.length}`);

        // Haal sprint namen op voor alle issues
        const sprintNames = new Map<string, string>();
        for (const issue of issues) {
            if (issue.fields.customfield_10020 && issue.fields.customfield_10020.length > 0) {
                sprintNames.set(issue.key, await getSprintName(issue));
            }
        }

        // Genereer HTML
        const html = generateHtml(issues, googleSheetsData, workLogs, sprintNames);
        res.send(html);
    } catch (error) {
        logger.error(`Error: ${error}`);
        res.status(500).send('Er is een fout opgetreden bij het ophalen van de data.');
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
    return Number((seconds / 3600).toFixed(1)).toString();
}

function calculatePlanning(issues: Issue[], googleSheetsData: string[][] | null, projectType: 'atlantis' | 'subscription'): { issue: Issue; sprint: number }[] {
    logger.log(`Start getPlanning functie voor project ${projectType}...`);
    
    // Maak een map van effectieve uren en projecten per medewerker
    const employeeDataMap = new Map<string, { hours: number; projects: string[] }>();
    if (googleSheetsData) {
        googleSheetsData.slice(1).forEach(row => {
            const name = row[2];
            const effectiveHours = Number((parseFloat(row[6]) || 0).toFixed(1));
            const projects = (row[7] || '').split(',').map(p => p.trim());
            employeeDataMap.set(name, { hours: effectiveHours, projects });
            logger.log(`Medewerker ${name} heeft ${effectiveHours} effectieve uren per week en werkt op projecten: ${projects.join(', ')}`);
        });
    }

    // Filter issues op basis van projecten waar medewerkers op werken
    const filteredIssues = issues.filter(issue => {
        const assignee = issue.fields.assignee?.displayName;
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

    logger.log(`Aantal gefilterde issues voor ${projectType}: ${filteredIssues.length}`);

    // Sorteer issues op prioriteit (Highest -> High -> Medium -> Low)
    const priorityOrder = ['Highest', 'High', 'Medium', 'Low'];
    
    // Bereid issues voor met prioriteit en opvolgers
    const issuesWithPriority = filteredIssues.map(issue => ({
        issue,
        priority: priorityOrder.indexOf(issue.fields.priority.name),
        hasSuccessors: getSuccessors(issue).length > 0,
        hours: Number(((issue.fields.timeestimate || 0) / 3600).toFixed(1)), // Converteer naar uren en rond af op 1 decimaal
        isActive: issue.fields.status.name === 'Open' || issue.fields.status.name === 'In review',
        isWaiting: issue.fields.status.name === 'Waiting',
        predecessors: getPredecessors(issue),
        isPeterIssue: issue.fields.assignee?.displayName === 'Peter van Diermen'
    }));

    logger.log(`Aantal issues om te plannen: ${issuesWithPriority.length}`);

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
        const sprintCapacity = Number((employeeHours * 2).toFixed(1)); // 2 weken per sprint, afgerond op 1 decimaal

        logger.log(`\nBezig met plannen van issue ${issue.key} (${hours} uren) voor ${assignee} - Status: ${issue.fields.status.name}`);
        logger.log(`Beschikbare uren per sprint voor ${assignee}: ${sprintCapacity}`);

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
                logger.log(`Issue ${issue.key} is Waiting en wordt gepland in sprint ${assignedSprint} (na voorgangers)`);
            }
        }

        // Controleer eerst de huidige sprint
        const currentSprintHours = sprintHours.get(assignedSprint)!;
        const currentEmployeeHours = Number((currentSprintHours.get(assignee) || 0).toFixed(1));

        logger.log(`Huidige sprint (${assignedSprint}): ${currentEmployeeHours} uren gebruikt van ${sprintCapacity}`);

        // Als er nog tijd over is in de huidige sprint, plaats het issue daar
        if (currentEmployeeHours < sprintCapacity) {
            // Controleer of het issue binnen de resterende beschikbare tijd past
            const remainingCapacity = sprintCapacity - currentEmployeeHours;
            console.log(`\nControle beschikbare tijd voor ${assignee} in sprint ${assignedSprint}:`);
            console.log(`- Sprint capaciteit: ${sprintCapacity} uren`);
            console.log(`- Gebruikte uren: ${currentEmployeeHours} uren`);
            console.log(`- Resterende capaciteit: ${remainingCapacity} uren`);
            console.log(`- Issue uren: ${hours} uren`);

            if (hours <= remainingCapacity) {
                // Update sprint uren
                currentSprintHours.set(assignee, currentEmployeeHours + hours);
                sprintHours.set(assignedSprint, currentSprintHours);
                foundSprint = true;
                console.log(`✓ Issue past binnen de beschikbare tijd (${hours} uren <= ${remainingCapacity} uren)`);
            } else {
                console.log(`✗ Issue past niet binnen de beschikbare tijd (${hours} uren > ${remainingCapacity} uren)`);
                // Zoek de volgende sprint
                assignedSprint++;
                while (assignedSprint <= maxSprints) {
                    const sprintEmployeeHours = sprintHours.get(assignedSprint) || new Map<string, number>();
                    const employeeHoursInSprint = sprintEmployeeHours.get(assignee) || 0;

                    console.log(`\nControle sprint ${assignedSprint}:`);
                    console.log(`- Sprint capaciteit: ${sprintCapacity} uren`);
                    console.log(`- Gebruikte uren: ${employeeHoursInSprint} uren`);
                    console.log(`- Resterende capaciteit: ${sprintCapacity - employeeHoursInSprint} uren`);
                    console.log(`- Issue uren: ${hours} uren`);

                    // Als er nog tijd over is in deze sprint, plaats het issue daar
                    if (employeeHoursInSprint < sprintCapacity) {
                        const remainingCapacity = sprintCapacity - employeeHoursInSprint;
                        if (hours <= remainingCapacity) {
                            // Update sprint uren
                            sprintEmployeeHours.set(assignee, employeeHoursInSprint + hours);
                            sprintHours.set(assignedSprint, sprintEmployeeHours);
                            foundSprint = true;
                            console.log(`✓ Issue past binnen de beschikbare tijd (${hours} uren <= ${remainingCapacity} uren)`);
                            break;
                        } else {
                            console.log(`✗ Issue past niet binnen de beschikbare tijd (${hours} uren > ${remainingCapacity} uren)`);
                        }
                    } else {
                        console.log(`✗ Sprint ${assignedSprint} is vol (${employeeHoursInSprint} uren gebruikt van ${sprintCapacity} uren)`);
                    }

                    assignedSprint++;
                }
            }
        } else {
            console.log(`\nSprint ${assignedSprint} is vol voor ${assignee}:`);
            console.log(`- Sprint capaciteit: ${sprintCapacity} uren`);
            console.log(`- Gebruikte uren: ${currentEmployeeHours} uren`);
            console.log(`- Issue uren: ${hours} uren`);
            // Zoek de volgende sprint
            assignedSprint++;
            while (assignedSprint <= maxSprints) {
                const sprintEmployeeHours = sprintHours.get(assignedSprint) || new Map<string, number>();
                const employeeHoursInSprint = sprintEmployeeHours.get(assignee) || 0;

                console.log(`\nControle sprint ${assignedSprint}:`);
                console.log(`- Sprint capaciteit: ${sprintCapacity} uren`);
                console.log(`- Gebruikte uren: ${employeeHoursInSprint} uren`);
                console.log(`- Resterende capaciteit: ${sprintCapacity - employeeHoursInSprint} uren`);
                console.log(`- Issue uren: ${hours} uren`);

                // Als er nog tijd over is in deze sprint, plaats het issue daar
                if (employeeHoursInSprint < sprintCapacity) {
                    const remainingCapacity = sprintCapacity - employeeHoursInSprint;
                    if (hours <= remainingCapacity) {
                        // Update sprint uren
                        sprintEmployeeHours.set(assignee, employeeHoursInSprint + hours);
                        sprintHours.set(assignedSprint, sprintEmployeeHours);
                        foundSprint = true;
                        console.log(`✓ Issue past binnen de beschikbare tijd (${hours} uren <= ${remainingCapacity} uren)`);
                        break;
                    } else {
                        console.log(`✗ Issue past niet binnen de beschikbare tijd (${hours} uren > ${remainingCapacity} uren)`);
                    }
                } else {
                    console.log(`✗ Sprint ${assignedSprint} is vol (${employeeHoursInSprint} uren gebruikt van ${sprintCapacity} uren)`);
                }

                assignedSprint++;
            }
        }

        if (!foundSprint) {
            logger.log(`WAARSCHUWING: Issue ${issue.key} past niet binnen ${maxSprints} sprints voor ${assignee}`);
            // Toewijzen aan laatste sprint als fallback
            assignedSprint = maxSprints;
        }

        sprintPlanning.push({ issue, sprint: assignedSprint });
        issueSprintMap.set(issue.key, assignedSprint);
        logger.log(`Issue ${issue.key} toegewezen aan sprint ${assignedSprint}`);
    }

    // Herverdeel Peter's issues over de beschikbare uren
    logger.log('\nStart herverdelen van Peter\'s issues...');
    const peterIssues = sprintPlanning.filter(({ issue }) => 
        issue.fields.assignee?.displayName === 'Peter van Diermen'
    );
    
    logger.log(`Aantal Peter's issues om te herverdelen: ${peterIssues.length}`);
    
    for (const { issue } of peterIssues) {
        const hours = Number(((issue.fields.timeestimate || 0) / 3600).toFixed(1));
        logger.log(`\nBezig met herverdelen van Peter's issue ${issue.key} (${hours} uren)`);

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
                logger.log(`Sprint ${targetSprint}: ${assignee} heeft ${availableHours} uren beschikbaar (${usedHours} gebruikt van ${sprintCapacity})`);
            }

            logger.log(`Sprint ${targetSprint}: ${totalAvailableHours} uren beschikbaar in totaal voor issue ${issue.key} (${hours} uren nodig)`);

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
                            logger.log(`Toegewezen ${hoursToAssign} uren aan ${assignee} in sprint ${targetSprint} (${remainingHours} uren over)`);
                        } else {
                            logger.log(`Kan ${hoursToAssign} uren niet toewijzen aan ${assignee} omdat dit de sprint capaciteit van ${sprintCapacity} zou overschrijden`);
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
                        logger.log(`Peter's issue ${issue.key} verplaatst naar sprint ${targetSprint}`);
                        foundSprint = true;
                        break;
                    }
                } else {
                    logger.log(`Kon niet alle uren toewijzen in sprint ${targetSprint} (${remainingHours} uren over), zoek volgende sprint`);
                }
            }
        }

        if (!foundSprint) {
            logger.log(`WAARSCHUWING: Kon Peter's issue ${issue.key} niet herverdelen over de sprints`);
        }
    }

    logger.log('Planning voltooid');
    return sprintPlanning;
}

function getSprintName(issue: Issue): string {
    if (!issue.fields.customfield_10020 || issue.fields.customfield_10020.length === 0) {
        return 'Niet gepland';
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
        const hours = Number(((issue.fields.timeestimate || 0) / 3600).toFixed(1)); // Converteer naar uren en rond af op 1 decimaal
        
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

function generateHtml(issues: Issue[], googleSheetsData: string[][] | null, workLogs: any[], sprintNames: Map<string, string>): string {
    // Splits issues in projecten
    const subscriptionIssues = issues.filter(issue => 
        issue.fields.parent?.key === 'EET-5236' || issue.fields.parent?.key === 'EET-6096'
    );
    const atlantisIssues = issues.filter(issue => 
        issue.fields.parent?.key !== 'EET-5236' && issue.fields.parent?.key !== 'EET-6096'
    );

    // Bereken planning met sprints voor beide projecten
    const subscriptionPlanning = calculatePlanning(subscriptionIssues, googleSheetsData, 'subscription');
    const atlantisPlanning = calculatePlanning(atlantisIssues, googleSheetsData, 'atlantis');

    // Bereken uren per sprint voor beide projecten
    const subscriptionSprintHours = getSprintHours(subscriptionPlanning, 'subscription');
    const atlantisSprintHours = getSprintHours(atlantisPlanning, 'atlantis');

    return `
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
            
            <h2>Alle Issues</h2>
            <table>
                <thead>
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
                        <th>Sprint</th>
                    </tr>
                </thead>
                <tbody>
                    ${issues.map(issue => `
                        <tr>
                            <td><a href="https://deventit.atlassian.net/browse/${issue.key}" target="_blank">${issue.key}</a></td>
                            <td>${issue.fields.summary}</td>
                            <td>${issue.fields.status.name}</td>
                            <td>${issue.fields.assignee?.displayName || 'Niet toegewezen'}</td>
                            <td>${formatTime(issue.fields.timeoriginalestimate)}</td>
                            <td>${formatTime(issue.fields.timeestimate)}</td>
                            <td>${getPredecessors(issue)}</td>
                            <td>${getSuccessors(issue)}</td>
                            <td>${issue.fields.parent ? `<a href="https://deventit.atlassian.net/browse/${issue.fields.parent.key}" target="_blank">${issue.fields.parent.key}</a>` : '-'}</td>
                            <td>${sprintNames.get(issue.key) || 'Niet gepland'}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>

            <h2>Planning Atlantis 7</h2>
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
                    <th>Issue</th>
                    <th>Uren</th>
                    <th>Uren beschikbaar</th>
                    <th>Uren over</th>
                </tr>
                ${subscriptionSprintHours.map(({ sprint, person, hours }) => {
                    const employeeHours = googleSheetsData ? Number((parseFloat(googleSheetsData.slice(1).find(row => row[2] === person)?.[6] || '0')).toFixed(1)) : 0;
                    const sprintCapacity = Number((employeeHours * 2).toFixed(1));
                    const atlantisHours = atlantisSprintHours.find(h => h.sprint === sprint && h.person === person)?.hours || 0;
                    const availableHours = Number((Math.max(0, sprintCapacity - atlantisHours)).toFixed(1));
                    const remainingHours = Number((Math.max(0, availableHours - hours)).toFixed(1));
                    
                    // Haal issues op voor deze sprint en persoon
                    const sprintIssues = subscriptionPlanning
                        .filter(p => p.sprint === sprint && p.issue.fields.assignee?.displayName === person)
                        .map(p => ({
                            key: p.issue.key,
                            hours: Number(((p.issue.fields.timeestimate || 0) / 3600).toFixed(1))
                        }));

                    // Genereer rijen voor issues
                    const issueRows = sprintIssues.map(issue => `
                        <tr>
                            <td>${sprint}</td>
                            <td>${person}</td>
                            <td>${issue.key}</td>
                            <td>${issue.hours.toFixed(1)}</td>
                            <td>${availableHours.toFixed(1)}</td>
                            <td>${remainingHours.toFixed(1)}</td>
                        </tr>
                    `).join('');

                    // Voeg een samenvattingsrij toe voor deze persoon
                    const summaryRow = `
                        <tr style="background-color: #f0f0f0; font-weight: bold;">
                            <td>${sprint}</td>
                            <td>${person}</td>
                            <td>Totaal</td>
                            <td>${hours.toFixed(1)}</td>
                            <td>${availableHours.toFixed(1)}</td>
                            <td>${remainingHours.toFixed(1)}</td>
                        </tr>
                    `;

                    return issueRows + summaryRow;
                }).join('')}
                ${Array.from(new Set(subscriptionSprintHours.map(h => h.sprint))).map(sprint => {
                    const sprintHours = subscriptionSprintHours.filter(h => h.sprint === sprint);
                    const totalHours = Number((sprintHours.reduce((sum, h) => sum + h.hours, 0)).toFixed(1));
                    
                    // Bereken totale beschikbare uren voor het project
                    const totalAvailableHours = googleSheetsData ? Number((googleSheetsData.slice(1).reduce((sum, row) => {
                        const person = row[2];
                        const projects = (row[7] || '').split(',').map(p => p.trim());
                        if (projects.includes('Subscriptions')) {
                            const effectiveHours = Number((parseFloat(row[6]) || 0).toFixed(1));
                            const sprintCapacity = Number((effectiveHours * 2).toFixed(1));
                            const atlantisHours = atlantisSprintHours.find(h => h.sprint === sprint && h.person === person)?.hours || 0;
                            return sum + Number((Math.max(0, sprintCapacity - atlantisHours)).toFixed(1));
                        }
                        return sum;
                    }, 0)).toFixed(1)) : 0;
                    
                    const totalRemainingHours = Number((Math.max(0, totalAvailableHours - totalHours)).toFixed(1));

                    return `
                        <tr style="background-color: #e0e0e0; font-weight: bold;">
                            <td>${sprint}</td>
                            <td colspan="2">Sprint Totaal</td>
                            <td>${totalHours.toFixed(1)}</td>
                            <td>${totalAvailableHours.toFixed(1)}</td>
                            <td>${totalRemainingHours.toFixed(1)}</td>
                        </tr>
                    `;
                }).join('')}
            </table>

            <h2>Uren per Sprint Atlantis 7</h2>
            <table>
                <tr>
                    <th>Sprint</th>
                    <th>Persoon</th>
                    <th>Issue</th>
                    <th>Uren</th>
                    <th>Uren beschikbaar</th>
                    <th>Uren over</th>
                </tr>
                ${atlantisSprintHours.map(({ sprint, person, hours }) => {
                    const employeeHours = googleSheetsData ? Number((parseFloat(googleSheetsData.slice(1).find(row => row[2] === person)?.[6] || '0')).toFixed(1)) : 0;
                    const sprintCapacity = Number((employeeHours * 2).toFixed(1));
                    const subscriptionHours = subscriptionSprintHours.find(h => h.sprint === sprint && h.person === person)?.hours || 0;
                    const availableHours = Number((Math.max(0, sprintCapacity - subscriptionHours)).toFixed(1));
                    const remainingHours = Number((Math.max(0, availableHours - hours)).toFixed(1));
                    
                    // Haal issues op voor deze sprint en persoon
                    const sprintIssues = atlantisPlanning
                        .filter(p => p.sprint === sprint && p.issue.fields.assignee?.displayName === person)
                        .map(p => ({
                            key: p.issue.key,
                            hours: Number(((p.issue.fields.timeestimate || 0) / 3600).toFixed(1))
                        }));

                    // Genereer rijen voor issues
                    const issueRows = sprintIssues.map(issue => `
                        <tr>
                            <td>${sprint}</td>
                            <td>${person}</td>
                            <td>${issue.key}</td>
                            <td>${issue.hours.toFixed(1)}</td>
                            <td>${availableHours.toFixed(1)}</td>
                            <td>${remainingHours.toFixed(1)}</td>
                        </tr>
                    `).join('');

                    // Voeg een samenvattingsrij toe voor deze persoon
                    const summaryRow = `
                        <tr style="background-color: #f0f0f0; font-weight: bold;">
                            <td>${sprint}</td>
                            <td>${person}</td>
                            <td>Totaal</td>
                            <td>${hours.toFixed(1)}</td>
                            <td>${availableHours.toFixed(1)}</td>
                            <td>${remainingHours.toFixed(1)}</td>
                        </tr>
                    `;

                    return issueRows + summaryRow;
                }).join('')}
                ${Array.from(new Set(atlantisSprintHours.map(h => h.sprint))).map(sprint => {
                    const sprintHours = atlantisSprintHours.filter(h => h.sprint === sprint);
                    const totalHours = Number((sprintHours.reduce((sum, h) => sum + h.hours, 0)).toFixed(1));
                    
                    // Bereken totale beschikbare uren voor het project
                    const totalAvailableHours = googleSheetsData ? Number((googleSheetsData.slice(1).reduce((sum, row) => {
                        const person = row[2];
                        const projects = (row[7] || '').split(',').map(p => p.trim());
                        if (projects.includes('Atlantis 7')) {
                            const effectiveHours = Number((parseFloat(row[6]) || 0).toFixed(1));
                            const sprintCapacity = Number((effectiveHours * 2).toFixed(1));
                            const subscriptionHours = subscriptionSprintHours.find(h => h.sprint === sprint && h.person === person)?.hours || 0;
                            return sum + Number((Math.max(0, sprintCapacity - subscriptionHours)).toFixed(1));
                        }
                        return sum;
                    }, 0)).toFixed(1)) : 0;
                    
                    const totalRemainingHours = Number((Math.max(0, totalAvailableHours - totalHours)).toFixed(1));

                    return `
                        <tr style="background-color: #e0e0e0; font-weight: bold;">
                            <td>${sprint}</td>
                            <td colspan="2">Sprint Totaal</td>
                            <td>${totalHours.toFixed(1)}</td>
                            <td>${totalAvailableHours.toFixed(1)}</td>
                            <td>${totalRemainingHours.toFixed(1)}</td>
                        </tr>
                    `;
                }).join('')}
            </table>

            <div class="nav-link">
                <a href="/worklogs">Bekijk Work Logging</a>
            </div>
        </body>
        </html>
    `;
}

const planningHandler: RequestHandler = async (req, res): Promise<void> => {
    try {
        const planning = await getPlanning();
        logger.log('Planning opgehaald');
        res.json(planning);
    } catch (error) {
        logger.error('Fout bij ophalen planning');
        res.status(500).json({ error: 'Fout bij ophalen planning' });
    }
};

const worklogsHandler: RequestHandler = async (req, res): Promise<void> => {
    try {
        const { startDate, endDate } = req.query;
        if (!startDate || !endDate) {
            res.status(400).json({ error: 'Start en eind datum zijn verplicht' });
            return;
        }

        const worklogs = await getWorkLogs(startDate as string, endDate as string);
        logger.log('Worklogs opgehaald');
        res.json(worklogs);
    } catch (error) {
        logger.error('Fout bij ophalen worklogs');
        res.status(500).json({ error: 'Fout bij ophalen worklogs' });
    }
};

app.get('/api/planning', planningHandler);
app.get('/api/worklogs', worklogsHandler);

app.listen(port, () => {
    logger.log(`Server draait op poort ${port}`);
}); 