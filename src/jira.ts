import axios from 'axios';
import { Issue } from './types';
import * as dotenv from 'dotenv';
import path from 'path';

// Laad .env.local bestand
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const JIRA_DOMAIN = process.env.JIRA_HOST;
const JIRA_EMAIL = process.env.JIRA_USERNAME;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

if (!JIRA_DOMAIN || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    throw new Error('Missende Jira configuratie. Zorg ervoor dat JIRA_HOST, JIRA_USERNAME en JIRA_API_TOKEN zijn ingesteld in je .env.local bestand.');
}

const auth = {
    username: JIRA_EMAIL,
    password: JIRA_API_TOKEN
};

const jiraClient = axios.create({
    baseURL: `https://${JIRA_DOMAIN}/rest/api/3`,
    auth: auth,
    headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
    }
});

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
  };
}

interface IssueLink {
  type: {
    name: string;
    inward: string;
    outward: string;
  };
  inwardIssue?: {
    key: string;
  };
  outwardIssue?: {
    key: string;
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
        console.log('Start ophalen van Jira issues...');
        console.log('Jira configuratie:', {
            domain: JIRA_DOMAIN,
            email: JIRA_EMAIL,
            hasToken: !!JIRA_API_TOKEN
        });
        
        let allIssues: Issue[] = [];
        let startAt = 0;
        const maxResults = 100;
        let hasMore = true;

        while (hasMore) {
            const response = await jiraClient.get('/search', {
                params: {
                    jql: 'project = EET AND status IN (Registered, Open, Reopened, Waiting, "In review") AND issuetype != Epic AND key != EET-6095 AND key != EET-4991 AND key != EET-3560 AND key != EET-3561 ORDER BY priority DESC',
                    fields: 'summary,status,assignee,timeestimate,timeoriginalestimate,priority,parent,issuelinks,issuetype,customfield_10020',
                    expand: 'names,schema',
                    maxResults: maxResults,
                    startAt: startAt
                }
            });

            const issues = response.data.issues || [];
            allIssues = allIssues.concat(issues);
            
            console.log(`Pagina ${Math.floor(startAt / maxResults) + 1}: ${issues.length} issues gevonden`);
            
            // Check of er meer pagina's zijn
            hasMore = issues.length === maxResults;
            startAt += maxResults;
        }
        
        console.log('Totaal aantal issues gevonden:', allIssues.length);
        return allIssues;
    } catch (error: any) {
        console.error('Error fetching issues:', {
            message: error.message,
            response: error.response?.data,
            status: error.response?.status
        });
        return [];
    }
}

export async function getWorkLogs(startDate: string, endDate: string): Promise<any[]> {
    try {
        const response = await jiraClient.get('/search', {
            params: {
                jql: `project = EET AND worklogDate >= "${startDate}" AND worklogDate <= "${endDate}"`,
                fields: 'worklog,summary,assignee,issuelinks,parent,timeestimate,timeoriginalestimate,priority',
                expand: 'names,schema',
                maxResults: 100
            }
        });

        const workLogs: any[] = [];
        response.data.issues.forEach((issue: any) => {
            if (issue.fields.worklog && issue.fields.worklog.worklogs) {
                issue.fields.worklog.worklogs.forEach((worklog: any) => {
                    const workDate = new Date(worklog.started);
                    const start = new Date(startDate);
                    const end = new Date(endDate);
                    
                    if (workDate >= start && workDate <= end) {
                        workLogs.push({
                            issueKey: issue.key,
                            issueSummary: issue.fields.summary,
                            author: worklog.author.displayName,
                            timeSpentSeconds: worklog.timeSpentSeconds,
                            started: worklog.started,
                            comment: worklog.comment || ''
                        });
                    }
                });
            }
        });

        return workLogs;
    } catch (error) {
        console.error('Error fetching work logs:', error);
        return [];
    }
}

export async function getSprintName(issue: Issue): Promise<string> {
    console.log(`\nOphalen sprint naam voor issue ${issue.key}`);
    console.log('Sprint data:', issue.fields.customfield_10020);
    
    if (!issue.fields.customfield_10020 || issue.fields.customfield_10020.length === 0) {
        console.log('Geen sprint gevonden voor dit issue');
        return 'Niet gepland';
    }
    
    // Neem de eerste actieve sprint
    const activeSprint = issue.fields.customfield_10020.find(sprint => sprint.state === 'active');
    if (activeSprint) {
        console.log(`Actieve sprint gevonden: ${activeSprint.id}`);
        try {
            console.log(`Ophalen sprint details voor sprint ${activeSprint.id}`);
            const response = await jiraClient.get(`/rest/agile/1.0/sprint/${activeSprint.id}`);
            console.log('Sprint response:', response.data);
            return response.data.name;
        } catch (error) {
            console.error(`Error fetching sprint name for sprint ${activeSprint.id}:`, error);
            return activeSprint.name;
        }
    }
    
    // Als er geen actieve sprint is, neem de eerste sprint
    const sprint = issue.fields.customfield_10020[0];
    console.log(`Geen actieve sprint gevonden, gebruik eerste sprint: ${sprint.id}`);
    try {
        console.log(`Ophalen sprint details voor sprint ${sprint.id}`);
        const response = await jiraClient.get(`/rest/agile/1.0/sprint/${sprint.id}`);
        console.log('Sprint response:', response.data);
        return response.data.name;
    } catch (error) {
        console.error(`Error fetching sprint name for sprint ${sprint.id}:`, error);
        return sprint.name;
    }
}

interface Sprint {
    id: number;
    name: string;
    state: string;
}

interface SprintCapacity {
    assignee: string;
    capacity: number;
}

interface PriorityOrder {
    [key: string]: number;
}

export async function getSprintCapacity(): Promise<SprintCapacity[]> {
    const response = await jiraClient.get('/rest/api/3/search?jql=project = EET AND issuetype = "Sprint Capacity"');
    return response.data.issues.map((issue: any) => ({
        assignee: issue.fields.assignee?.displayName || 'Unassigned',
        capacity: issue.fields.customfield_10014 || 0
    }));
}

export async function getPlanning(): Promise<Issue[]> {
    const issues = await getActiveIssues();
    const sprintCapacity = await getSprintCapacity();
    const sprintCapacityMap = new Map(sprintCapacity.map((cap: SprintCapacity) => [cap.assignee, cap.capacity]));
    
    // Groepeer issues per medewerker
    const issuesPerAssignee = new Map<string, Issue[]>();
    issues.forEach(issue => {
        const assignee = issue.fields.assignee?.displayName || 'Unassigned';
        if (!issuesPerAssignee.has(assignee)) {
            issuesPerAssignee.set(assignee, []);
        }
        issuesPerAssignee.get(assignee)?.push(issue);
    });

    // Verwerk elke medewerker
    const maxSprints = 10;
    const sprintAssignments = new Map<number, Map<string, Issue[]>>();
    const sprintHours = new Map<number, Map<string, number>>();
    const issueSprintMap = new Map<string, number>();

    // Initialiseer de maps voor elke sprint
    for (let sprint = 1; sprint <= maxSprints; sprint++) {
        sprintAssignments.set(sprint, new Map());
        sprintHours.set(sprint, new Map());
    }

    // Verwerk elke medewerker
    for (const [assignee, assigneeIssues] of issuesPerAssignee) {
        const capacity = sprintCapacityMap.get(assignee) || 0;
        console.log(`\nVerwerken van issues voor ${assignee} (${assigneeIssues.length} issues)`);
        console.log(`Beschikbare uren per sprint: ${capacity}`);

        // Sorteer issues op prioriteit
        const priorityOrder: PriorityOrder = { Highest: 1, High: 2, Medium: 3, Low: 4, Lowest: 5 };
        const sortedIssues = assigneeIssues.sort((a, b) => priorityOrder[a.fields.priority.name] - priorityOrder[b.fields.priority.name]);

        // Verwerk eerst issues zonder opvolgers
        const issuesWithoutSuccessors = sortedIssues.filter(issue => 
            !issue.fields.issuelinks?.some(link => 
                link.type.name === 'Blocks' && link.outwardIssue
            )
        );

        // Verwerk issues zonder opvolgers
        for (const issue of issuesWithoutSuccessors) {
            const hours = issue.fields.timeestimate || 0;
            let assigned = false;

            // Zoek een sprint waar dit issue in past
            for (let sprint = 1; sprint <= maxSprints; sprint++) {
                const currentHours = sprintHours.get(sprint)?.get(assignee) || 0;
                const remainingCapacity = capacity - currentHours;

                // Controleer strikt of het issue past binnen de resterende capaciteit
                if (hours <= remainingCapacity) {
                    if (!sprintAssignments.get(sprint)?.has(assignee)) {
                        sprintAssignments.get(sprint)?.set(assignee, []);
                    }
                    sprintAssignments.get(sprint)?.get(assignee)?.push(issue);
                    sprintHours.get(sprint)?.set(assignee, currentHours + hours);
                    issueSprintMap.set(issue.key, sprint);
                    assigned = true;
                    console.log(`Issue ${issue.key} (${hours} uren) toegewezen aan sprint ${sprint} voor ${assignee}`);
                    console.log(`Nieuwe sprint uren: ${currentHours + hours} van ${capacity}`);
                    break;
                }
            }

            if (!assigned) {
                console.log(`WAARSCHUWING: Issue ${issue.key} past niet binnen de beschikbare uren voor ${assignee}`);
            }
        }

        // Verwerk issues met opvolgers
        const issuesWithSuccessors = sortedIssues.filter(issue => 
            issue.fields.issuelinks?.some(link => 
                link.type.name === 'Blocks' && link.outwardIssue
            )
        );

        for (const issue of issuesWithSuccessors) {
            const hours = issue.fields.timeestimate || 0;
            let assigned = false;

            // Bepaal de vroegst mogelijke sprint op basis van de issues waarvan dit een opvolger is
            let earliestPossibleSprint = 1;
            if (issue.fields.issuelinks) {
                for (const link of issue.fields.issuelinks) {
                    if (link.type.name === 'Blocks' && link.outwardIssue) {
                        const predecessorSprint = issueSprintMap.get(link.outwardIssue.key) || 0;
                        earliestPossibleSprint = Math.max(earliestPossibleSprint, predecessorSprint + 1);
                    }
                }
            }

            // Zoek een sprint waar dit issue in past, beginnend bij de vroegst mogelijke sprint
            for (let sprint = earliestPossibleSprint; sprint <= maxSprints; sprint++) {
                const currentHours = sprintHours.get(sprint)?.get(assignee) || 0;
                const remainingCapacity = capacity - currentHours;

                // Controleer strikt of het issue past binnen de resterende capaciteit
                if (hours <= remainingCapacity) {
                    if (!sprintAssignments.get(sprint)?.has(assignee)) {
                        sprintAssignments.get(sprint)?.set(assignee, []);
                    }
                    sprintAssignments.get(sprint)?.get(assignee)?.push(issue);
                    sprintHours.get(sprint)?.set(assignee, currentHours + hours);
                    issueSprintMap.set(issue.key, sprint);
                    assigned = true;
                    console.log(`Issue ${issue.key} (${hours} uren) toegewezen aan sprint ${sprint} voor ${assignee}`);
                    console.log(`Nieuwe sprint uren: ${currentHours + hours} van ${capacity}`);
                    break;
                }
            }

            if (!assigned) {
                console.log(`WAARSCHUWING: Issue ${issue.key} met opvolgers past niet binnen de beschikbare uren voor ${assignee}`);
            }
        }
    }

    // Vul resterende tijd op met issues van Peter van Diermen
    const peterIssues = issuesPerAssignee.get('Peter van Diermen') || [];
    const peterCapacity = sprintCapacityMap.get('Peter van Diermen') || 0;

    // Sorteer Peter's issues op prioriteit
    const priorityOrder: PriorityOrder = { Highest: 1, High: 2, Medium: 3, Low: 4, Lowest: 5 };
    const sortedPeterIssues = peterIssues.sort((a, b) => priorityOrder[a.fields.priority.name] - priorityOrder[b.fields.priority.name]);

    // Verwerk Peter's issues per sprint
    for (let sprint = 1; sprint <= maxSprints; sprint++) {
        const currentHours = sprintHours.get(sprint)?.get('Peter van Diermen') || 0;
        const remainingCapacity = peterCapacity - currentHours;

        if (remainingCapacity > 0) {
            for (const issue of sortedPeterIssues) {
                const hours = issue.fields.timeestimate || 0;
                
                // Skip als het issue al is toegewezen
                if (sprintAssignments.get(sprint)?.get('Peter van Diermen')?.some(i => i.key === issue.key)) {
                    continue;
                }

                // Controleer strikt of het issue past binnen de resterende capaciteit
                if (hours <= remainingCapacity) {
                    if (!sprintAssignments.get(sprint)?.has('Peter van Diermen')) {
                        sprintAssignments.get(sprint)?.set('Peter van Diermen', []);
                    }
                    sprintAssignments.get(sprint)?.get('Peter van Diermen')?.push(issue);
                    sprintHours.get(sprint)?.set('Peter van Diermen', currentHours + hours);
                    console.log(`Issue ${issue.key} (${hours} uren) toegewezen aan sprint ${sprint} voor Peter van Diermen`);
                    console.log(`Nieuwe sprint uren: ${currentHours + hours} van ${peterCapacity}`);
                }
            }
        }
    }

    // Update de sprint toewijzingen
    for (const [sprint, assigneeIssues] of sprintAssignments) {
        for (const [assignee, sprintIssues] of assigneeIssues) {
            const totalHours = sprintIssues.reduce((sum, issue) => sum + (issue.fields.timeestimate || 0), 0);
            const capacity = sprintCapacityMap.get(assignee) || 0;
            console.log(`\nSprint ${sprint} voor ${assignee}:`);
            console.log(`Totaal gebruikte uren: ${totalHours} van ${capacity}`);
            if (totalHours > capacity) {
                console.error(`ERROR: Sprint ${sprint} voor ${assignee} overschrijdt de capaciteit: ${totalHours} > ${capacity}`);
            }
            for (const issue of sprintIssues) {
                const hours = issue.fields.timeestimate || 0;
                console.log(`- ${issue.key}: ${hours} uren`);
                issue.fields.customfield_10020 = [{
                    id: sprint,
                    name: `Sprint ${sprint}`,
                    state: sprint === 1 ? 'active' : 'future'
                }];
            }
        }
    }

    return issues;
} 