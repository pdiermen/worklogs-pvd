import axios from 'axios';
import type { Issue, IssueLink, WorkLog, WorkLogsResponse, EfficiencyData } from './types.js';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import { WorkLogsResponse as OldWorkLogsResponse, EfficiencyTable } from './types.js';
import { getSprintCapacityFromSheet, ProjectConfig, getProjectConfigsFromSheet, getGoogleSheetsData } from './google-sheets.js';
import { format } from 'date-fns';

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

export function isEETIssue(issue: Issue): boolean {
  return issue.key.startsWith('EET-');
}

export function formatTime(seconds: number | undefined): string {
  if (!seconds) return '-';
  const hours = (seconds / 3600).toFixed(1); // deel door 3600 (60 min * 60 sec) en rond af op 1 decimaal
  return hours;
}

// Cache voor actieve issues
let activeIssuesCache: { issues: Issue[]; timestamp: number } | null = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minuten

export async function getActiveIssues(): Promise<Issue[]> {
    console.log('[DEBUG] getActiveIssues functie wordt aangeroepen');
    
    const response = await jiraClient.get('/rest/api/2/search', {
        params: {
            jql: 'project in (SUBSCRIPTION, ATLANTIS) AND status in (Open, "In Progress", "To Do")',
            expand: 'changelog,issuelinks',
            fields: 'summary,status,assignee,issuelinks,timeoriginalestimate,customfield_10020,project,priority,created,worklog'
        }
    });
    
    // Log de volledige API response voor het eerste issue
    if (response.data.issues.length > 0) {
        console.log('[DEBUG] Volledige API response voor eerste issue:', JSON.stringify(response.data.issues[0], null, 2));
    }
    
    return response.data.issues;
}

export async function getWorkLogs(projectKey: string, startDate: string, endDate: string, jqlFilter?: string): Promise<WorkLog[]> {
    try {
        // Basis JQL query
        let jql = `project = ${projectKey} AND worklogDate >= "${startDate}" AND worklogDate <= "${endDate}"`;
        if (jqlFilter) {
            jql += ` AND ${jqlFilter}`;
        }
        logger.log(`Volledige JQL Query voor Worklogs: ${jql}`);
        
        const response = await axios.get(
            `https://${JIRA_DOMAIN}/rest/api/3/search`,
            {
                headers: {
                    'Authorization': `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64')}`,
                    'Content-Type': 'application/json'
                },
                params: {
                    jql,
                    fields: [
                        'summary',
                        'status',
                        'assignee',
                        'priority',
                        'worklog'
                    ].join(','),
                    maxResults: 100
                }
            }
        );
        
        const worklogs: WorkLog[] = [];
        
        for (const issue of response.data.issues) {
            const issueWorklogs = issue.fields.worklog?.worklogs || [];
            
            for (const log of issueWorklogs) {
                const logDate = new Date(log.started);
                const start = new Date(startDate);
                const end = new Date(endDate);
                
                if (logDate >= start && logDate <= end) {
                    worklogs.push({
                        issueKey: issue.key,
                        issueSummary: issue.fields.summary,
                        issueStatus: issue.fields.status.name,
                        issueAssignee: issue.fields.assignee?.displayName || 'Onbekend',
                        issuePriority: issue.fields.priority?.name || 'Lowest',
                        author: typeof log.author === 'string' ? log.author : log.author.displayName,
                        timeSpentSeconds: log.timeSpentSeconds,
                        started: log.started,
                        comment: log.comment
                    });
                }
            }
        }
        
        logger.log(`Totaal aantal worklogs gevonden: ${worklogs.length}`);
        return worklogs;
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

export async function getIssuesForProject(projectCodes: string[], jqlFilter?: string, worklogFilter?: string): Promise<Issue[]> {
    const allIssues: Issue[] = [];
    let startAt = 0;
    const maxResults = 100;
    let hasMore = true;
    let totalIssues = 0;

    // Haal de periode filter uit de worklogFilter
    const periodMatch = worklogFilter?.match(/worklogDate >= "([^"]+)" AND worklogDate <= "([^"]+)"/);
    const periodFilter = periodMatch ? `AND worklogDate >= "${periodMatch[1]}" AND worklogDate <= "${periodMatch[2]}"` : '';

    while (hasMore) {
        const jql = `(${projectCodes.map(code => `project = ${code}`).join(' OR ')}) ${jqlFilter ? `AND ${jqlFilter}` : ''} ${periodFilter}`;
        logger.log(`Volledige JQL Query voor Issues: ${jql}`);
        
        const response = await jiraClient.get('/search', {
            params: {
                jql,
                startAt,
                maxResults,
                fields: [
                    'summary',
                    'issuetype',
                    'status',
                    'assignee',
                    'timeestimate',
                    'timeoriginalestimate',
                    'timespent',
                    'customfield_10014',
                    'parent',
                    'issuelinks',
                    'priority'
                ]
            }
        });

        const issues = response.data.issues.map((issue: any) => ({
            key: issue.key,
            fields: {
                summary: issue.fields.summary,
                issuetype: issue.fields.issuetype,
                status: issue.fields.status,
                assignee: issue.fields.assignee,
                timeestimate: issue.fields.timeestimate,
                timeoriginalestimate: issue.fields.timeoriginalestimate,
                timespent: issue.fields.timespent,
                customfield_10014: issue.fields.customfield_10014,
                parent: issue.fields.parent,
                issuelinks: issue.fields.issuelinks,
                priority: issue.fields.priority
            }
        }));

        allIssues.push(...issues);
        totalIssues = response.data.total;
        
        logger.log(`Aantal issues gevonden in deze batch: ${issues.length}`);
        logger.log(`Totaal aantal issues tot nu toe: ${allIssues.length}`);
        logger.log(`Totaal aantal issues volgens Jira: ${totalIssues}`);
        
        // Check of er meer resultaten zijn
        hasMore = allIssues.length < totalIssues;
        if (hasMore) {
            logger.log(`Er zijn meer resultaten beschikbaar (totaal: ${totalIssues}). Paginering nodig.`);
            startAt += maxResults;
        } else {
            logger.log(`Alle resultaten opgehaald (totaal: ${totalIssues}).`);
        }
    }

    logger.log(`Aantal issues gevonden: ${allIssues.length}`);
    return allIssues;
}

interface JiraWorkLog {
    started: string;
    timeSpentSeconds: number;
    author: string | { displayName: string };
    comment?: string;
}

export async function getWorkLogsForProject(
    projectCodes: string[],
    startDate: Date,
    endDate: Date,
    config: ProjectConfig
): Promise<WorkLog[]> {
    const worklogs: WorkLog[] = [];
    let startAt = 0;
    const maxResults = 100;

    // Bouw basis JQL query met project filter
    let jql = `project in (${projectCodes.map(code => `"${code}"`).join(',')})`;
    
    // Voeg periode filter toe
    jql += ` AND worklogDate >= "${startDate.toISOString().split('T')[0]}" AND worklogDate <= "${endDate.toISOString().split('T')[0]}"`;
    
    // Als er een jqlFilter is, voeg deze toe
    if (config.jqlFilter) {
        jql += ` AND ${config.jqlFilter}`;
    }
    // Als er een worklogJql is, voeg deze toe
    else if (config.worklogJql && config.worklogJql.trim() !== '') {
        jql += ` AND (${config.worklogJql})`;
    }

    logger.log(`\n=== Worklog Query ===`);
    logger.log(`Project: "${config.projectName}"`);
    logger.log(`JQL: ${jql}`);

    try {
        // Haal issues op met worklogs in de opgegeven periode
        const response = await jiraClient.get('/search', {
            params: {
                jql,
                maxResults,
                startAt,
                fields: 'summary,project,assignee,worklog'
            }
        });

        const issues = response.data.issues || [];
        logger.log(`Aantal issues gevonden: ${issues.length}`);

        // Haal voor elk issue de worklogs op
        for (const issue of issues) {
            try {
                // Controleer of het issue bij het juiste project hoort
                if (!projectCodes.includes(issue.fields.project.key)) {
                    logger.log(`Issue ${issue.key} hoort niet bij project ${projectCodes.join(',')}, wordt overgeslagen`);
                    continue;
                }

                const worklogResponse = await jiraClient.get(`/issue/${issue.key}/worklog`);
                const issueWorklogs = (worklogResponse.data.worklogs || []) as JiraWorkLog[];
                
                if (issueWorklogs.length > 0) {
                    // Filter worklogs op basis van de datum
                    const filteredWorklogs = issueWorklogs.filter((log: JiraWorkLog) => {
                        const logDate = new Date(log.started);
                        return logDate >= startDate && logDate <= endDate;
                    });

                    if (filteredWorklogs.length > 0) {
                           const processedWorklogs = filteredWorklogs.map((log: JiraWorkLog) => ({
                            issueKey: issue.key,
                            issue: {
                                key: issue.key,
                                fields: {
                                    summary: issue.fields.summary,
                                    project: issue.fields.project,
                                    assignee: issue.fields.assignee,
                                    timeoriginalestimate: issue.fields.timeoriginalestimate,
                                    timeestimate: issue.fields.timeestimate,
                                    priority: issue.fields.priority
                                }
                            },
                            started: log.started,
                            timeSpentSeconds: log.timeSpentSeconds,
                            author: typeof log.author === 'string' ? log.author : log.author.displayName,
                            comment: log.comment,
                            category: 'ontwikkeling' as const
                        }));
                        
                        worklogs.push(...processedWorklogs);
                    } else {
                        logger.log(`Issue ${issue.key}: Geen worklogs gevonden in de opgegeven periode`);
                    }
                } else {
                    logger.log(`Issue ${issue.key}: Geen worklogs gevonden`);
                }
            } catch (error) {
                logger.error(`Error bij ophalen worklogs voor issue ${issue.key}: ${error}`);
                // Ga door met de volgende issue
                continue;
            }
        }

        return worklogs;
    } catch (error) {
        logger.error(`Error bij ophalen van worklogs: ${error}`);
        throw error;
    }
}

export async function getWorklogsForIssues(issues: Issue[]): Promise<WorkLog[]> {
    try {
        const issueKeys = issues.map(issue => issue.key);
        const worklogIssuesJql = `key in (${issueKeys.join(',')})`;
        logger.log(`Volledige JQL Query voor Worklogs: ${worklogIssuesJql}`);
        
        const worklogs: WorkLog[] = [];
        let startAt = 0;
        const maxResults = 100;
        let hasMore = true;
        let totalIssues = 0;

        while (hasMore) {
            const response = await axios.get(
                `https://${JIRA_DOMAIN}/rest/api/3/search`,
                {
                    headers: {
                        'Authorization': `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64')}`,
                        'Content-Type': 'application/json'
                    },
                    params: {
                        jql: worklogIssuesJql,
                        fields: ['worklog', 'summary', 'status', 'assignee', 'priority'],
                        startAt,
                        maxResults
                    }
                }
            );
            
            const batchIssues = response.data.issues;
            totalIssues = response.data.total;
            
            // Verwerk worklogs voor elke issue
            for (const issue of batchIssues) {
                const issueWorklogs = issue.fields.worklog?.worklogs || [];
                logger.log(`Issue ${issue.key}: ${issueWorklogs.length} worklogs gevonden`);
                
                for (const log of issueWorklogs) {
                    worklogs.push({
                        issueKey: issue.key,
                        issueSummary: issue.fields.summary,
                        issueStatus: issue.fields.status.name,
                        issueAssignee: issue.fields.assignee?.displayName || 'Onbekend',
                        issuePriority: issue.fields.priority?.name || 'Lowest',
                        author: typeof log.author === 'string' ? log.author : log.author.displayName,
                        timeSpentSeconds: log.timeSpentSeconds,
                        started: log.started,
                        comment: log.comment
                    });
                }
            }
            
            logger.log(`Aantal worklogs gevonden in deze batch: ${worklogs.length}`);
            logger.log(`Totaal aantal worklogs tot nu toe: ${worklogs.length}`);
            
            hasMore = worklogs.length < totalIssues;
            if (hasMore) {
                logger.log(`Er zijn meer resultaten beschikbaar (totaal: ${totalIssues}). Paginering nodig.`);
                startAt += maxResults;
            } else {
                logger.log(`Alle resultaten opgehaald (totaal: ${totalIssues}).`);
            }
        }
        
        return worklogs;
    } catch (error) {
        logger.error(`Error bij ophalen van worklogs: ${error}`);
        throw error;
    }
}

export async function getIssuesWithWorklogs(startDate: string, endDate: string): Promise<Issue[]> {
    try {
        const jql = `project = EET AND worklogDate >= "${startDate}" AND worklogDate <= "${endDate}"`;
        logger.log(`Volledige JQL Query voor Issues met Worklogs: ${jql}`);
        
        const allIssues: Issue[] = [];
        let startAt = 0;
        const maxResults = 100;
        let hasMore = true;
        let totalIssues = 0;

        while (hasMore) {
            const response = await axios.get(
                `https://${JIRA_DOMAIN}/rest/api/3/search`,
                {
                    headers: {
                        'Authorization': `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64')}`,
                        'Content-Type': 'application/json'
                    },
                    params: {
                        jql,
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
                            'customfield_10020',
                            'worklog'
                        ].join(','),
                        startAt,
                        maxResults
                    }
                }
            );
            
            const batchIssues = response.data.issues;
            allIssues.push(...batchIssues);
            totalIssues = response.data.total;
            
            logger.log(`Aantal issues gevonden in deze batch: ${batchIssues.length}`);
            logger.log(`Totaal aantal issues tot nu toe: ${allIssues.length}`);
            logger.log(`Totaal aantal issues volgens Jira: ${totalIssues}`);
            
            hasMore = allIssues.length < totalIssues;
            if (hasMore) {
                logger.log(`Er zijn meer resultaten beschikbaar (totaal: ${totalIssues}). Paginering nodig.`);
                startAt += maxResults;
            } else {
                logger.log(`Alle resultaten opgehaald (totaal: ${totalIssues}).`);
            }
        }
        
        return allIssues;
    } catch (error) {
        logger.error(`Error bij ophalen van issues met worklogs: ${error}`);
        throw error;
    }
}

export async function getIssues(jql: string): Promise<Issue[]> {
    try {
        const response = await jiraClient.get('/search', {
            params: {
                jql,
                maxResults: 1000,
                fields: [
                    'summary',
                    'timeestimate',
                    'timeoriginalestimate',
                    'status',
                    'assignee',
                    'created',
                    'resolutiondate',
                    'worklog'
                ]
            }
        });
        logger.log(`Volledige JQL Query voor Issues: ${jql}`);
        logger.log(`Opgehaalde issues: ${response.data.issues.length}`);
        return response.data.issues;
    } catch (error: any) {
        logger.error(`Fout bij ophalen issues: ${error}`);
        if (error.response?.data) {
            logger.error(`API Response: ${JSON.stringify(error.response.data)}`);
        }
        return [];
    }
}