import axios from 'axios';
import type { Issue, IssueLink, WorkLog, WorkLogsResponse, EfficiencyData } from './types.js';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import { WorkLogsResponse as OldWorkLogsResponse, EfficiencyTable } from './types';
import { getSprintCapacityFromSheet } from './google-sheets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Laad .env.local bestand
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const JIRA_DOMAIN = process.env.JIRA_HOST;
const JIRA_EMAIL = process.env.JIRA_USERNAME;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

// Check required environment variables
if (!JIRA_EMAIL || !JIRA_API_TOKEN || !JIRA_DOMAIN) {
    throw new Error('Missing required environment variables: JIRA_EMAIL, JIRA_API_TOKEN, or JIRA_DOMAIN');
}

// Create Jira client
export const jiraClient = axios.create({
    baseURL: `https://${process.env.JIRA_HOST}/rest/api/2`,
    auth: {
        username: process.env.JIRA_USERNAME!,
        password: process.env.JIRA_API_TOKEN!
    },
    headers: {
        'Accept': 'application/json'
    }
});

// Error handler voor Axios requests
jiraClient.interceptors.response.use(
    response => response,
    error => {
        if (error.response) {
            // De server heeft een response gestuurd met een status code buiten het 2xx bereik
            logger.error(`Jira API Error Response: ${JSON.stringify({
                status: error.response.status,
                statusText: error.response.statusText,
                data: error.response.data
            }, null, 2)}`);
        } else if (error.request) {
            // De request is gemaakt maar er is geen response ontvangen
            logger.error(`Jira API Error Request: ${JSON.stringify(error.request, null, 2)}`);
        } else {
            // Er is iets misgegaan bij het opzetten van de request
            logger.error(`Jira API Error: ${error.message}`);
        }
        
        // Gooi een nieuwe error met meer details
        const enhancedError = new Error(`Jira API Error: ${error.message}`);
        (enhancedError as any).status = error.response?.status;
        (enhancedError as any).data = error.response?.data;
        return Promise.reject(enhancedError);
    }
);

export interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    status: {
      name: string;
    };
    assignee?: {
      displayName: string;
    };
    customfield_10002?: number; // Story Points
    timeoriginalestimate?: number; // Original Estimate
    timeestimate?: number; // Remaining Estimate
    timetracking?: {
      originalEstimateSeconds: number;
      remainingEstimateSeconds: number;
      timeSpentSeconds: number;
    };
    issuelinks?: Array<{
      type: {
        name: string;
        inward: string;
        outward: string;
      };
      inwardIssue?: {
        key: string;
        fields: {
          summary: string;
        };
      };
      outwardIssue?: {
        key: string;
        fields: {
          summary: string;
        };
      };
    }>;
    parent?: {
      key: string;
      fields: {
        summary: string;
      };
    };
    customfield_10020?: Array<{
      id: string;
      self: string;
      state: string;
      name: string;
    }>;
    issuetype: {
      name: string;
    };
  };
}

export function isEETIssue(issue: JiraIssue): boolean {
  return issue.key.startsWith('EET-');
}

export function formatTime(seconds: number | undefined): string {
  if (!seconds) return '-';
  const hours = (seconds / 3600).toFixed(1); // deel door 3600 (60 min * 60 sec) en rond af op 1 decimaal
  return hours;
}

export async function getActiveIssues(): Promise<Issue[]> {
    try {
        const response = await axios.get(
            `https://${JIRA_DOMAIN}/rest/api/3/search`,
            {
                headers: {
                    'Authorization': `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64')}`,
                    'Content-Type': 'application/json'
                },
                params: {
                    jql: 'project = EET AND status not in (Closed, Done)',
                    fields: [
                        'summary',
                        'status',
                        'assignee',
                        'issuetype',
                        'priority',
                        'timeestimate',
                        'timeoriginalestimate',
                        'issuelinks',
                        'parent',
                        'customfield_10020'
                    ].join(','),
                    expand: 'changelog',
                    maxResults: 1000
                }
            }
        );

        console.log('\n=== JIRA Issues Ophalen ===');
        console.log('Doel: Ophalen van actieve issues voor planning en capaciteitsberekening');
        console.log('JQL Query: project = EET AND status not in (Closed, Done)');
        console.log(`Aantal issues gevonden: ${response.data.issues.length}`);
        
        console.log('\nGevonden Issues:');
        response.data.issues.forEach((issue: Issue) => {
            console.log(`\nIssue: ${issue.key}`);
            console.log(`- Samenvatting: ${issue.fields?.summary}`);
            console.log(`- Status: ${issue.fields?.status?.name}`);
            console.log(`- Toegewezen aan: ${issue.fields?.assignee?.displayName || 'Niet toegewezen'}`);
            console.log(`- Type: ${issue.fields?.issuetype?.name}`);
            console.log(`- Prioriteit: ${issue.fields?.priority?.name}`);
            console.log(`- Parent: ${issue.fields?.parent?.key || 'Geen'}`);
            console.log(`- Geplande uren: ${formatTime(issue.fields?.timeestimate)}`);
            console.log(`- Sprint: ${issue.fields?.customfield_10020?.map(s => s.name).join(', ') || 'Niet gepland'}`);
            console.log(`- Changelog: ${issue.changelog?.histories?.length || 0} histories`);
        });

        return response.data.issues;
    } catch (error) {
        console.error('Fout bij ophalen van issues:', error);
        throw error;
    }
}

export async function getWorkLogs(startDate: string, endDate: string): Promise<WorkLogsResponse> {
    try {
        // Haal alle issues op met worklogs in de opgegeven periode
        const worklogIssuesJql = `project = ${process.env.JIRA_PROJECT} AND worklogDate >= "${startDate}" AND worklogDate <= "${endDate}" ORDER BY updated DESC`;
        
        logger.log(`JQL Query voor worklogs: ${worklogIssuesJql}`);
        
        const worklogIssuesResponse = await jiraClient.get('/search', {
            params: {
                jql: worklogIssuesJql,
                fields: ['summary', 'timetracking', 'assignee', 'status', 'timeestimate', 'timeoriginalestimate', 'worklog', 'issuetype'],
                expand: ['changelog', 'worklog'],
                maxResults: 1000
            }
        });

        const worklogIssues = worklogIssuesResponse.data.issues || [];
        logger.log(`Aantal issues gevonden met worklogs: ${worklogIssues.length}`);
        
        // Verzamel alle worklogs
        const allWorklogs: WorkLog[] = [];
        const efficiencyTable = new Map<string, { 
            estimated: number; 
            logged: number;
        }>();
        
        // Verwerk worklog issues
        for (const issue of worklogIssues) {
            try {
                // Haal worklogs direct op voor dit issue
                const worklogResponse = await jiraClient.get(`/issue/${issue.key}/worklog`);
                const worklogs = worklogResponse.data.worklogs || [];
                logger.log(`Issue ${issue.key} heeft ${worklogs.length} worklogs`);
                
                for (const worklog of worklogs) {
                    const logDate = new Date(worklog.started);
                    if (logDate >= new Date(startDate) && logDate <= new Date(endDate)) {
                        const author = worklog.author.displayName;
                        const timeSpentHours = worklog.timeSpentSeconds / 3600;
                        
                        // Categoriseer de worklog
                        let category: 'nietGewerkt' | 'nietOpIssue' | 'ontwikkeling' = 'ontwikkeling';
                        if (issue.key === 'EET-3561') {
                            category = 'nietGewerkt';
                        } else if (issue.key === 'EET-3560') {
                            category = 'nietOpIssue';
                        }
                        
                        allWorklogs.push({
                            issueKey: issue.key,
                            issueSummary: issue.fields?.summary || '',
                            author: author,
                            timeSpentSeconds: worklog.timeSpentSeconds,
                            started: worklog.started,
                            comment: worklog.comment,
                            estimatedTime: issue.fields?.timeoriginalestimate || 0,
                            category: category
                        });
                        
                        // Update efficiency table
                        const current = efficiencyTable.get(author) || { 
                            estimated: 0, 
                            logged: 0
                        };
                        
                        current.logged += timeSpentHours;
                        efficiencyTable.set(author, current);
                    }
                }
                
                // Update efficiency table met estimated time
                const assignee = issue.fields?.assignee?.displayName;
                if (assignee) {
                    const current = efficiencyTable.get(assignee) || { 
                        estimated: 0, 
                        logged: 0
                    };
                    current.estimated += (issue.fields?.timeoriginalestimate || 0) / 3600;
                    efficiencyTable.set(assignee, current);
                }
            } catch (issueError) {
                logger.error(`Error bij verwerken van issue ${issue.key}: ${issueError}`);
                // Ga door met de volgende issue
                continue;
            }
        }
        
        logger.log(`Totaal aantal worklogs gevonden: ${allWorklogs.length}`);
        
        // Converteer efficiency table naar array
        const efficiencyData: EfficiencyData[] = Array.from(efficiencyTable.entries()).map(([assignee, data]) => ({
            assignee,
            estimated: data.estimated.toFixed(1),
            logged: data.logged.toFixed(1),
            efficiency: data.estimated > 0 ? ((data.logged / data.estimated) * 100).toFixed(1) : '0.0'
        }));
        
        logger.log(`Efficiency data: ${JSON.stringify(efficiencyData, null, 2)}`);
        
        // Groepeer worklogs per medewerker
        const workLogsByEmployee = new Map<string, WorkLog[]>();
        allWorklogs.forEach(log => {
            const logs = workLogsByEmployee.get(log.author) || [];
            logs.push(log);
            workLogsByEmployee.set(log.author, logs);
        });

        // Bereken totalen per categorie per medewerker
        const workLogsSummary = Array.from(workLogsByEmployee.entries()).map(([employee, logs]) => {
            const nietGewerkt = logs.filter(log => log.issueKey === 'EET-3561');
            const nietOpIssues = logs.filter(log => log.issueKey === 'EET-3560');
            const ontwikkeling = logs.filter(log => log.issueKey !== 'EET-3561' && log.issueKey !== 'EET-3560');

            const nietGewerktUren = nietGewerkt.reduce((sum, log) => sum + log.timeSpentSeconds, 0) / 3600;
            const nietOpIssuesUren = nietOpIssues.reduce((sum, log) => sum + log.timeSpentSeconds, 0) / 3600;
            const ontwikkelingUren = ontwikkeling.reduce((sum, log) => sum + log.timeSpentSeconds, 0) / 3600;
            const totalUren = Number((nietGewerktUren + nietOpIssuesUren + ontwikkelingUren).toFixed(1));

            return {
                employee,
                nietGewerkt: nietGewerktUren.toFixed(1),
                nietOpIssues: nietOpIssuesUren.toFixed(1),
                ontwikkeling: ontwikkelingUren.toFixed(1),
                total: totalUren.toFixed(1)
            };
        });

        return {
            workLogs: allWorklogs,
            efficiencyTable: efficiencyData,
            workLogsSummary
        };
    } catch (error) {
        logger.error(`Error in getWorkLogs: ${error}`);
        // Gooi de error door zodat deze correct kan worden afgehandeld door de aanroepende code
        throw error;
    }
}

export async function getSprintName(issue: Issue): Promise<string> {
    try {
        logger.log(`Ophalen sprint naam voor issue ${issue.key}`);
        
        if (!issue.fields?.customfield_10020 || issue.fields.customfield_10020.length === 0) {
            logger.log(`Geen sprint gevonden voor issue ${issue.key}`);
            return 'Niet gepland';
        }
        
        // Neem de eerste actieve sprint
        const activeSprint = issue.fields.customfield_10020.find(sprint => sprint.state === 'active');
        if (activeSprint) {
            logger.log(`Actieve sprint gevonden voor issue ${issue.key}: ${activeSprint.name}`);
            return activeSprint.name;
        }
        
        // Als er geen actieve sprint is, neem de eerste sprint
        const sprint = issue.fields.customfield_10020[0];
        logger.log(`Geen actieve sprint gevonden voor issue ${issue.key}, gebruik eerste sprint: ${sprint.name}`);
        return sprint.name;
    } catch (error) {
        logger.error(`Error bij ophalen sprint naam voor issue ${issue.key}: ${error}`);
        return 'Niet gepland';
    }
}

interface SprintCapacity {
    assignee: string;
    capacity: number;
    sprintId: number;
}

interface PriorityOrder {
    [key: string]: number;
}

export async function getSprintCapacity(): Promise<SprintCapacity[]> {
    try {
        logger.log('Start ophalen van sprint capaciteit...');
        
        // Haal de capaciteit op uit Google Sheets
        const sheetCapacities = await getSprintCapacityFromSheet();
        
        // Standaard capaciteit per medewerker als fallback
        const defaultCapacities: { [key: string]: number } = {
            'Peter van Diermen': 40,
            'Adit Shah': 60,
            'Bart Hermans': 16,
            'Florian de Jong': 8,
            'Milan van Dijk': 40,
            'virendra kumar': 60
        };

        // Maak een lijst van capaciteiten met standaard waarden
        const capacities: SprintCapacity[] = [];
        const maxSprints = 10;

        // Voeg alle medewerkers toe met hun standaard capaciteit
        Object.entries(defaultCapacities).forEach(([assignee, capacity]) => {
            for (let i = 1; i <= maxSprints; i++) {
                // Check of er een capaciteit uit de sheet is voor deze medewerker en sprint
                const sheetCapacity = sheetCapacities.find(c => c.assignee === assignee && c.sprintId === i);
                capacities.push({
                    assignee,
                    capacity: sheetCapacity?.capacity || capacity,
                    sprintId: i
                });
            }
        });

        logger.log(`${capacities.length} sprint capaciteiten gegenereerd`);
        return capacities;
    } catch (error: any) {
        logger.error(`Error bij ophalen van sprint capaciteit: ${error.message}`);
        throw error;
    }
}

interface PlanningResult {
  issues: Issue[];
  sprints: SprintCapacity[];
  sprintAssignments: Record<string, Record<string, Issue[]>>;
  sprintHours: Record<string, Record<string, number>>;
}

export async function getPlanning(): Promise<PlanningResult> {
    try {
        logger.log('Start ophalen van planning data...');
        
        // Haal alle benodigde data parallel op
        let issues: Issue[] = [];
        let sprintCapacities: SprintCapacity[] = [];
        
        try {
            logger.log('Ophalen van actieve issues...');
            issues = await getActiveIssues();
            logger.log(`${issues.length} actieve issues gevonden`);
        } catch (error: any) {
            logger.error(`Error bij ophalen van issues: ${error.message}`);
            throw new Error(`Fout bij ophalen van issues: ${error.message}`);
        }

        try {
            logger.log('Ophalen van sprint capaciteit...');
            sprintCapacities = await getSprintCapacity();
            logger.log(`${sprintCapacities.length} sprint capaciteiten gevonden`);
        } catch (error: any) {
            logger.error(`Error bij ophalen van sprint capaciteit: ${error.message}`);
            throw new Error(`Fout bij ophalen van sprint capaciteit: ${error.message}`);
        }

        // Implementeer de rest van de getPlanning functie
        // Dit is een voorbeeld en moet worden aangepast aan de specifieke vereisten van de planning logica
        const planningResult: PlanningResult = {
            issues,
            sprints: sprintCapacities,
            sprintAssignments: {},
            sprintHours: {}
        };

        logger.log('Planning data opgehaald');
        return planningResult;
    } catch (error: any) {
        logger.error(`Error bij ophalen van planning data: ${error.message}`);
        throw error;
    }
}