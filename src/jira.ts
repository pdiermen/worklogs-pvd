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
const jiraClient = axios.create({
    baseURL: `https://${process.env.JIRA_HOST}/rest/api/2`,
    auth: {
        username: process.env.JIRA_USERNAME!,
        password: process.env.JIRA_API_TOKEN!
    },
    headers: {
        'Accept': 'application/json'
    }
});

// Error handler voor axios requests
jiraClient.interceptors.response.use(
    response => response,
    async (error: any) => {
        let errorMessage = 'Onbekende fout';
        let errorDetails = {};
        let statusCode = 500;

        if (error.response) {
            statusCode = error.response.status;
            errorMessage = `Jira API error: ${error.response.status} - ${error.response.statusText}`;
            errorDetails = {
                status: error.response.status,
                statusText: error.response.statusText,
                url: error.config?.url,
                data: error.response.data,
                headers: error.config?.headers
            };
            logger.error(`Jira API error details: ${JSON.stringify(errorDetails, null, 2)}`);
        } else if (error.request) {
            errorMessage = `Geen response ontvangen van Jira API: ${error.message}`;
            errorDetails = {
                request: error.request,
                message: error.message,
                config: {
                    url: error.config?.url,
                    method: error.config?.method,
                    headers: error.config?.headers
                }
            };
            logger.error(`Request error details: ${JSON.stringify(errorDetails, null, 2)}`);
        } else {
            errorMessage = `Error bij het maken van request: ${error.message}`;
            errorDetails = {
                message: error.message,
                stack: error.stack
            };
            logger.error(`General error details: ${JSON.stringify(errorDetails, null, 2)}`);
        }

        const enhancedError = new Error(errorMessage) as any;
        enhancedError.statusCode = statusCode;
        enhancedError.details = errorDetails;
        enhancedError.stack = error.stack;

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
        });

        return response.data.issues;
    } catch (error) {
        console.error('Fout bij ophalen van issues:', error);
        throw error;
    }
}

export async function getWorkLogs(startDate: string, endDate: string): Promise<WorkLogsResponse> {
    try {
        logger.log(`Ophalen van worklogs van ${startDate} tot ${endDate}`);
        
        const workLogs: WorkLog[] = [];
        const efficiencyTable: EfficiencyTable = {};
        let totalWorklogEntries = 0;
        let filteredWorklogEntries = 0;
        let startAt = 0;
        const maxResults = 100;
        let hasMore = true;
        let totalIssues = 0;

        // Haal eerst alle Closed issues op die in de opgegeven periode zijn afgesloten
        const closedIssuesJql = `project = ${process.env.JIRA_PROJECT} AND status = Closed AND status CHANGED TO Closed AFTER "${startDate}" AND status CHANGED TO Closed BEFORE "${endDate}" ORDER BY updated DESC`;
        logger.log(`JQL voor Closed issues: ${closedIssuesJql}`);
        
        const closedIssuesResponse = await jiraClient.get('/search', {
            params: {
                jql: closedIssuesJql,
                fields: ['summary', 'timetracking', 'assignee', 'status', 'timeestimate', 'timeoriginalestimate'],
                maxResults: 1000
            }
        }).catch(error => {
            logger.error(`Error bij ophalen van Closed issues: ${error}`);
            throw error;
        });

        const closedIssues = closedIssuesResponse.data.issues || [];
        logger.log(`${closedIssues.length} Closed issues gevonden`);

        // Verwerk alle worklogs van Closed issues (voor efficiency tabel)
        for (const issue of closedIssues) {
            try {
                const worklogResponse = await jiraClient.get(`/issue/${issue.key}/worklog`).catch(error => {
                    logger.error(`Error bij ophalen worklogs voor Closed issue ${issue.key}: ${error}`);
                    return { data: { worklogs: [] } };
                });
                const worklog = worklogResponse.data;

                if (!worklog || !worklog.worklogs) {
                    continue;
                }

                // Log de timeestimate en timeoriginalestimate voor debugging
                logger.log(`Closed Issue ${issue.key}:
                    - Time Estimate: ${formatTime(issue.fields.timeestimate)}
                    - Original Estimate: ${formatTime(issue.fields.timeoriginalestimate)}
                    - Time Tracking: ${JSON.stringify(issue.fields.timetracking)}`);

                // Verwerk alle worklogs van dit Closed issue
                worklog.worklogs.forEach((entry: any) => {
                    const workLog: WorkLog = {
                        issueKey: issue.key,
                        issueSummary: issue.fields.summary,
                        author: entry.author.displayName,
                        timeSpentSeconds: entry.timeSpentSeconds,
                        started: entry.started,
                        comment: entry.comment || '',
                        estimatedTime: issue.fields.timeoriginalestimate || issue.fields.timeestimate || 0
                    };

                    // Update efficiency table
                    if (!efficiencyTable[entry.author.displayName]) {
                        efficiencyTable[entry.author.displayName] = {
                            totalTimeSpent: 0,
                            totalTimeEstimate: 0,
                            efficiency: 0
                        };
                    }

                    efficiencyTable[entry.author.displayName].totalTimeSpent += entry.timeSpentSeconds;
                    efficiencyTable[entry.author.displayName].totalTimeEstimate += workLog.estimatedTime;
                });
            } catch (error) {
                logger.error(`Error bij verwerken van Closed issue ${issue.key}: ${error}`);
                continue;
            }
        }

        // Haal nu worklogs op voor de opgegeven periode (voor Worklogging tabel)
        while (hasMore) {
            const jql = `project = ${process.env.JIRA_PROJECT} AND worklogDate >= "${startDate}" AND worklogDate <= "${endDate}" ORDER BY updated DESC`;
            logger.log(`JQL voor worklogs in periode: ${jql}`);
            
            const response = await jiraClient.get('/search', {
                params: {
                    jql,
                    fields: ['summary', 'timetracking', 'assignee', 'status', 'timeestimate', 'timeoriginalestimate'],
                    maxResults,
                    startAt
                }
            }).catch(error => {
                logger.error(`Error bij ophalen van worklogs in periode: ${error}`);
                throw error;
            });

            if (!response.data.issues) {
                logger.error('Geen issues gevonden in Jira response');
                throw new Error('Geen issues gevonden in Jira response');
            }

            const issues = response.data.issues;
            totalIssues += issues.length;
            logger.log(`${issues.length} issues gevonden op pagina ${Math.floor(startAt / maxResults) + 1}`);

            // Verwerk elke issue
            for (const issue of issues) {
                try {
                    const worklogResponse = await jiraClient.get(`/issue/${issue.key}/worklog`).catch(error => {
                        logger.error(`Error bij ophalen worklogs voor issue ${issue.key}: ${error}`);
                        return { data: { worklogs: [] } };
                    });
                    const worklog = worklogResponse.data;

                    if (!worklog || !worklog.worklogs) {
                        continue;
                    }

                    // Log de timeestimate en timeoriginalestimate voor debugging
                    logger.log(`Issue ${issue.key}:
                        - Time Estimate: ${formatTime(issue.fields.timeestimate)}
                        - Original Estimate: ${formatTime(issue.fields.timeoriginalestimate)}
                        - Time Tracking: ${JSON.stringify(issue.fields.timetracking)}`);

                    totalWorklogEntries += worklog.worklogs.length;

                    // Verwerk elke worklog entry
                    worklog.worklogs.forEach((entry: any) => {
                        const workLogDate = new Date(entry.started);
                        const startDateObj = new Date(startDate);
                        const endDateObj = new Date(endDate);

                        // Check of de worklog binnen de opgegeven periode valt
                        if (workLogDate >= startDateObj && workLogDate <= endDateObj) {
                            filteredWorklogEntries++;
                            const workLog: WorkLog = {
                                issueKey: issue.key,
                                issueSummary: issue.fields.summary,
                                author: entry.author.displayName,
                                timeSpentSeconds: entry.timeSpentSeconds,
                                started: entry.started,
                                comment: entry.comment || '',
                                estimatedTime: issue.fields.timeoriginalestimate || issue.fields.timeestimate || 0
                            };
                            workLogs.push(workLog);
                        }
                    });
                } catch (error) {
                    logger.error(`Error bij verwerken van issue ${issue.key}: ${error}`);
                    continue;
                }
            }

            // Check of er meer issues zijn
            hasMore = issues.length === maxResults;
            startAt += maxResults;
        }

        // Bereken efficiency voor elke medewerker
        const efficiencyData: EfficiencyData[] = Object.entries(efficiencyTable).map(([assignee, data]) => {
            const efficiency = data.totalTimeEstimate > 0 
                ? (data.totalTimeSpent / data.totalTimeEstimate) * 100 
                : 0;

            return {
                assignee,
                estimated: formatTime(data.totalTimeEstimate),
                logged: formatTime(data.totalTimeSpent),
                efficiency: efficiency.toFixed(1) + '%'
            };
        });

        logger.log(`Samenvatting:
        - ${totalIssues} issues met worklogs
        - ${filteredWorklogEntries} worklogs in periode
        - ${Object.keys(efficiencyTable).length} medewerkers met efficiency data`);

        return {
            workLogs,
            efficiencyTable: efficiencyData
        };
    } catch (error) {
        logger.error(`Error bij ophalen van worklogs: ${error}`);
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