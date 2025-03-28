import axios from 'axios';
import { Issue } from './types';
import * as dotenv from 'dotenv';
import path from 'path';
import { logger } from './utils/logger';

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
        logger.log('Start ophalen van Jira issues...');
        logger.log(`Jira configuratie - Domain: ${JIRA_DOMAIN}, Email: ${JIRA_EMAIL}, Has Token: ${!!JIRA_API_TOKEN}`);
        
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
            
            logger.log(`Pagina ${Math.floor(startAt / maxResults) + 1}: ${issues.length} issues gevonden`);
            
            // Check of er meer pagina's zijn
            hasMore = issues.length === maxResults;
            startAt += maxResults;
        }
        
        logger.log(`Totaal aantal issues gevonden: ${allIssues.length}`);
        return allIssues;
    } catch (error: any) {
        logger.error(`Error fetching issues: ${JSON.stringify({
            message: error.message,
            response: error.response?.data,
            status: error.response?.status
        })}`);
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

interface SprintCapacity {
    assignee: string;
    capacity: number;
    sprintId: number;
}

interface PriorityOrder {
    [key: string]: number;
}

export async function getSprintCapacity(): Promise<SprintCapacity[]> {
    const response = await jiraClient.get('/rest/api/3/search?jql=project = EET AND issuetype = "Sprint Capacity"');
    const maxSprints = 10;
    const capacities: SprintCapacity[] = [];
    
    // Standaard capaciteit per medewerker
    const defaultCapacities: { [key: string]: number } = {
        'Peter van Diermen': 40,
        'Adit Shah': 60,
        'Bart Hermans': 16,
        'Florian de Jong': 8,
        'Milan van Dijk': 40,
        'virendra kumar': 60
    };
    
    // Verwerk eerst de issues uit Jira
    response.data.issues.forEach((issue: any) => {
        const assignee = issue.fields.assignee?.displayName || 'Unassigned';
        const capacity = issue.fields.customfield_10014 || defaultCapacities[assignee] || 0;
        
        // Maak een capaciteit entry voor elke sprint
        for (let i = 1; i <= maxSprints; i++) {
            capacities.push({
                assignee,
                capacity,
                sprintId: i
            });
        }
    });
    
    // Voeg eventueel ontbrekende medewerkers toe met standaard capaciteit
    Object.entries(defaultCapacities).forEach(([assignee, capacity]) => {
        if (!capacities.some(c => c.assignee === assignee)) {
            for (let i = 1; i <= maxSprints; i++) {
                capacities.push({
                    assignee,
                    capacity,
                    sprintId: i
                });
            }
        }
    });
    
    return capacities;
}

interface PlanningResult {
  issues: Issue[];
  sprints: SprintCapacity[];
  sprintAssignments: Record<string, Record<string, Issue[]>>;
  sprintHours: Record<string, Record<string, number>>;
}

export async function getPlanning(): Promise<PlanningResult> {
  const issues = await getActiveIssues();
  const sprints = await getSprintCapacity();
  const sprintAssignments = new Map<string, Map<number, Issue[]>>();
  const sprintHours = new Map<string, Map<number, number>>();
  const sprintCapacity = new Map<string, Map<number, number>>();
  const sprintRemainingHours = new Map<string, Map<number, number>>();

  // Initialiseer maps voor sprint toewijzingen en uren
  sprints.forEach(sprint => {
    if (!sprintAssignments.has(sprint.assignee)) {
      sprintAssignments.set(sprint.assignee, new Map());
      sprintHours.set(sprint.assignee, new Map());
      sprintCapacity.set(sprint.assignee, new Map());
      sprintRemainingHours.set(sprint.assignee, new Map());
    }
    // Zet de capaciteit voor deze medewerker voor deze sprint
    sprintCapacity.get(sprint.assignee)?.set(sprint.sprintId, sprint.capacity);
    // Initialiseer de resterende uren met de volledige capaciteit
    sprintRemainingHours.get(sprint.assignee)?.set(sprint.sprintId, sprint.capacity);
  });

  // Log de geïnitialiseerde capaciteit en resterende uren
  logger.log('\nGeïnitialiseerde capaciteit en resterende uren per medewerker:');
  for (const [assignee, capacityMap] of sprintCapacity) {
    logger.log(`\n${assignee}:`);
    for (let sprintId = 1; sprintId <= 10; sprintId++) {
      const capacity = capacityMap.get(sprintId) || 0;
      const remaining = sprintRemainingHours.get(assignee)?.get(sprintId) || 0;
      logger.log(`Sprint ${sprintId}: ${capacity} uren capaciteit, ${remaining} uren resterend`);
    }
  }

  // Groepeer issues per project
  const issuesByProject = new Map<string, Issue[]>();
  issues.forEach(issue => {
    const projectKey = issue.key.split('-')[0];
    if (!issuesByProject.has(projectKey)) {
      issuesByProject.set(projectKey, []);
    }
    issuesByProject.get(projectKey)!.push(issue);
  });

  // Verwerk issues per project
  for (const [projectKey, projectIssues] of issuesByProject) {
    logger.log(`\nVerwerken van project ${projectKey}...`);
    
    // Sorteer issues op prioriteit en key
    const sortedIssues = [...projectIssues].sort((a, b) => {
      const priorityOrder: PriorityOrder = { Highest: 0, High: 1, Medium: 2, Low: 3, Lowest: 4 };
      const priorityCompare = (priorityOrder[a.fields.priority.name] || 5) - (priorityOrder[b.fields.priority.name] || 5);
      if (priorityCompare !== 0) return priorityCompare;
      return a.key.localeCompare(b.key);
    });

    // Verwerk eerst issues zonder opvolgers (behalve Peter van Diermen)
    for (const issue of sortedIssues) {
      if (issue.fields.assignee?.displayName === 'Peter van Diermen') continue;
      
      const successors = issue.fields.issuelinks?.filter(link => link.type.name === 'Blocks' && link.outwardIssue) || [];
      if (successors.length > 0) continue;

      const estimate = issue.fields.timeestimate || 0;
      const assignee = issue.fields.assignee?.displayName || 'Unassigned';
      logger.log(`\nBezig met plannen van issue ${issue.key} (${estimate} uren) voor ${assignee} - Status: ${issue.fields.status.name}`);
      
      // Zoek de vroegst mogelijke sprint
      let assigned = false;
      for (let sprintId = 1; sprintId <= 10 && !assigned; sprintId++) {
        const availableHours = sprintCapacity.get(assignee)?.get(sprintId) || 0;
        const remainingHours = sprintRemainingHours.get(assignee)?.get(sprintId) || 0;
        const assignments = sprintAssignments.get(assignee)?.get(sprintId) || [];
        const totalHours = assignments.reduce((sum, i) => sum + (i.fields.timeestimate || 0), 0);
        const currentHours = sprintHours.get(assignee)?.get(sprintId) || 0;

        logger.log(`\nControle sprint ${sprintId} voor ${assignee}:`);
        logger.log(`- Beschikbare uren: ${availableHours}`);
        logger.log(`- Huidige uren gebruikt: ${currentHours}`);
        logger.log(`- Totaal uren van toegewezen issues: ${totalHours}`);
        logger.log(`- Issue uren: ${estimate}`);
        logger.log(`- Resterende uren: ${remainingHours}`);

        // Controleer of er voldoende resterende uren zijn
        if (estimate <= remainingHours) {
          if (!sprintAssignments.get(assignee)?.has(sprintId)) {
            sprintAssignments.get(assignee)?.set(sprintId, []);
          }
          sprintAssignments.get(assignee)?.get(sprintId)?.push(issue);
          // Update de uur-tellers
          sprintHours.get(assignee)?.set(sprintId, currentHours + estimate);
          sprintRemainingHours.get(assignee)?.set(sprintId, remainingHours - estimate);
          logger.log(`✅ Issue ${issue.key} toegewezen aan sprint ${sprintId}`);
          logger.log(`- Nieuwe resterende uren: ${remainingHours - estimate}`);
          assigned = true;
        } else {
          logger.log(`❌ Issue ${issue.key} past niet in sprint ${sprintId}`);
          logger.log(`  - Issue uren (${estimate}) overschrijdt resterende uren (${remainingHours})`);
        }
      }

      if (!assigned) {
        logger.log(`⚠️ Issue ${issue.key} kon niet worden toegewezen aan een sprint binnen de beschikbare capaciteit`);
      }
    }

    // Verwerk issues met opvolgers (behalve Peter van Diermen)
    for (const issue of sortedIssues) {
      if (issue.fields.assignee?.displayName === 'Peter van Diermen') continue;
      
      const successors = issue.fields.issuelinks?.filter(link => link.type.name === 'Blocks' && link.outwardIssue) || [];
      if (successors.length === 0) continue;

      const estimate = issue.fields.timeestimate || 0;
      const assignee = issue.fields.assignee?.displayName || 'Unassigned';
      logger.log(`\nBezig met plannen van issue ${issue.key} (${estimate} uren) voor ${assignee} - Status: ${issue.fields.status.name}`);
      logger.log(`Opvolgers: ${successors.map(s => s.inwardIssue?.key).join(', ')}`);

      // Zoek de vroegst mogelijke sprint
      let assigned = false;
      for (let sprintId = 1; sprintId <= 10 && !assigned; sprintId++) {
        const availableHours = sprintCapacity.get(assignee)?.get(sprintId) || 0;
        const remainingHours = sprintRemainingHours.get(assignee)?.get(sprintId) || 0;
        const assignments = sprintAssignments.get(assignee)?.get(sprintId) || [];
        const totalHours = assignments.reduce((sum, i) => sum + (i.fields.timeestimate || 0), 0);
        const currentHours = sprintHours.get(assignee)?.get(sprintId) || 0;

        logger.log(`\nControle sprint ${sprintId} voor ${assignee}:`);
        logger.log(`- Beschikbare uren: ${availableHours}`);
        logger.log(`- Huidige uren gebruikt: ${currentHours}`);
        logger.log(`- Totaal uren van toegewezen issues: ${totalHours}`);
        logger.log(`- Issue uren: ${estimate}`);
        logger.log(`- Resterende uren: ${remainingHours}`);

        // Controleer of er voldoende resterende uren zijn
        if (estimate <= remainingHours) {
          if (!sprintAssignments.get(assignee)?.has(sprintId)) {
            sprintAssignments.get(assignee)?.set(sprintId, []);
          }
          sprintAssignments.get(assignee)?.get(sprintId)?.push(issue);
          // Update de uur-tellers
          sprintHours.get(assignee)?.set(sprintId, currentHours + estimate);
          sprintRemainingHours.get(assignee)?.set(sprintId, remainingHours - estimate);
          logger.log(`✅ Issue ${issue.key} toegewezen aan sprint ${sprintId}`);
          logger.log(`- Nieuwe resterende uren: ${remainingHours - estimate}`);
          assigned = true;
        } else {
          logger.log(`❌ Issue ${issue.key} past niet in sprint ${sprintId}`);
          logger.log(`  - Issue uren (${estimate}) overschrijdt resterende uren (${remainingHours})`);
        }
      }

      if (!assigned) {
        logger.log(`⚠️ Issue ${issue.key} kon niet worden toegewezen aan een sprint binnen de beschikbare capaciteit`);
      }
    }

    // Verwerk Peter van Diermen's issues
    const peterIssues = sortedIssues.filter(issue => issue.fields.assignee?.displayName === 'Peter van Diermen');
    logger.log(`\nVerwerken van ${peterIssues.length} issues voor Peter van Diermen...`);

    // Eerst issues zonder opvolgers
    for (const issue of peterIssues) {
      const successors = issue.fields.issuelinks?.filter(link => link.type.name === 'Blocks' && link.outwardIssue) || [];
      if (successors.length > 0) continue;

      const estimate = issue.fields.timeestimate || 0;
      logger.log(`\nBezig met plannen van issue ${issue.key} (${estimate} uren) voor Peter van Diermen - Status: ${issue.fields.status.name}`);

      // Zoek de vroegst mogelijke sprint
      let assigned = false;
      for (let sprintId = 1; sprintId <= 10 && !assigned; sprintId++) {
        const availableHours = sprintCapacity.get('Peter van Diermen')?.get(sprintId) || 0;
        const remainingHours = sprintRemainingHours.get('Peter van Diermen')?.get(sprintId) || 0;
        const assignments = sprintAssignments.get('Peter van Diermen')?.get(sprintId) || [];
        const totalHours = assignments.reduce((sum, i) => sum + (i.fields.timeestimate || 0), 0);
        const currentHours = sprintHours.get('Peter van Diermen')?.get(sprintId) || 0;

        logger.log(`\nControle sprint ${sprintId} voor Peter van Diermen:`);
        logger.log(`- Beschikbare uren: ${availableHours}`);
        logger.log(`- Huidige uren gebruikt: ${currentHours}`);
        logger.log(`- Totaal uren van toegewezen issues: ${totalHours}`);
        logger.log(`- Issue uren: ${estimate}`);
        logger.log(`- Resterende uren: ${remainingHours}`);

        // Controleer of er voldoende resterende uren zijn
        if (estimate <= remainingHours) {
          if (!sprintAssignments.get('Peter van Diermen')?.has(sprintId)) {
            sprintAssignments.get('Peter van Diermen')?.set(sprintId, []);
          }
          sprintAssignments.get('Peter van Diermen')?.get(sprintId)?.push(issue);
          // Update de uur-tellers
          sprintHours.get('Peter van Diermen')?.set(sprintId, currentHours + estimate);
          sprintRemainingHours.get('Peter van Diermen')?.set(sprintId, remainingHours - estimate);
          logger.log(`✅ Issue ${issue.key} toegewezen aan sprint ${sprintId}`);
          logger.log(`- Nieuwe resterende uren: ${remainingHours - estimate}`);
          assigned = true;
        } else {
          logger.log(`❌ Issue ${issue.key} past niet in sprint ${sprintId}`);
          logger.log(`  - Issue uren (${estimate}) overschrijdt resterende uren (${remainingHours})`);
        }
      }

      if (!assigned) {
        logger.log(`⚠️ Issue ${issue.key} kon niet worden toegewezen aan een sprint binnen de beschikbare capaciteit`);
      }
    }

    // Dan issues met opvolgers
    for (const issue of peterIssues) {
      const successors = issue.fields.issuelinks?.filter(link => link.type.name === 'Blocks' && link.outwardIssue) || [];
      if (successors.length === 0) continue;

      const estimate = issue.fields.timeestimate || 0;
      logger.log(`\nBezig met plannen van issue ${issue.key} (${estimate} uren) voor Peter van Diermen - Status: ${issue.fields.status.name}`);
      logger.log(`Opvolgers: ${successors.map(s => s.inwardIssue?.key).join(', ')}`);

      // Zoek de vroegst mogelijke sprint
      let assigned = false;
      for (let sprintId = 1; sprintId <= 10 && !assigned; sprintId++) {
        const availableHours = sprintCapacity.get('Peter van Diermen')?.get(sprintId) || 0;
        const remainingHours = sprintRemainingHours.get('Peter van Diermen')?.get(sprintId) || 0;
        const assignments = sprintAssignments.get('Peter van Diermen')?.get(sprintId) || [];
        const totalHours = assignments.reduce((sum, i) => sum + (i.fields.timeestimate || 0), 0);
        const currentHours = sprintHours.get('Peter van Diermen')?.get(sprintId) || 0;

        logger.log(`\nControle sprint ${sprintId} voor Peter van Diermen:`);
        logger.log(`- Beschikbare uren: ${availableHours}`);
        logger.log(`- Huidige uren gebruikt: ${currentHours}`);
        logger.log(`- Totaal uren van toegewezen issues: ${totalHours}`);
        logger.log(`- Issue uren: ${estimate}`);
        logger.log(`- Resterende uren: ${remainingHours}`);

        // Controleer of er voldoende resterende uren zijn
        if (estimate <= remainingHours) {
          if (!sprintAssignments.get('Peter van Diermen')?.has(sprintId)) {
            sprintAssignments.get('Peter van Diermen')?.set(sprintId, []);
          }
          sprintAssignments.get('Peter van Diermen')?.get(sprintId)?.push(issue);
          // Update de uur-tellers
          sprintHours.get('Peter van Diermen')?.set(sprintId, currentHours + estimate);
          sprintRemainingHours.get('Peter van Diermen')?.set(sprintId, remainingHours - estimate);
          logger.log(`✅ Issue ${issue.key} toegewezen aan sprint ${sprintId}`);
          logger.log(`- Nieuwe resterende uren: ${remainingHours - estimate}`);
          assigned = true;
        } else {
          logger.log(`❌ Issue ${issue.key} past niet in sprint ${sprintId}`);
          logger.log(`  - Issue uren (${estimate}) overschrijdt resterende uren (${remainingHours})`);
        }
      }

      if (!assigned) {
        logger.log(`⚠️ Issue ${issue.key} kon niet worden toegewezen aan een sprint binnen de beschikbare capaciteit`);
      }
    }
  }

  // Log de finale status van alle sprints
  logger.log('\nFinale status van alle sprints:');
  for (let sprintId = 1; sprintId <= 10; sprintId++) {
    logger.log(`\nSprint ${sprintId}:`);
    for (const [assignee, capacityMap] of sprintCapacity) {
      const capacity = capacityMap.get(sprintId) || 0;
      const remaining = sprintRemainingHours.get(assignee)?.get(sprintId) || 0;
      const used = sprintHours.get(assignee)?.get(sprintId) || 0;
      const assignments = sprintAssignments.get(assignee)?.get(sprintId) || [];
      const totalHours = assignments.reduce((sum, i) => sum + (i.fields.timeestimate || 0), 0);
      
      logger.log(`${assignee}:`);
      logger.log(`  - Capaciteit: ${capacity}`);
      logger.log(`  - Gebruikte uren: ${used}`);
      logger.log(`  - Resterende uren: ${remaining}`);
      logger.log(`  - Totaal uren van issues: ${totalHours}`);
      
      if (used > capacity || totalHours > capacity) {
        logger.log(`❌ OVERSCHRIJDING DETECTEERD:`);
        if (used > capacity) {
          logger.log(`  - Gebruikte uren (${used}) > Capaciteit (${capacity})`);
        }
        if (totalHours > capacity) {
          logger.log(`  - Totaal uren van issues (${totalHours}) > Capaciteit (${capacity})`);
        }
      }
    }
  }

  // Converteer Maps naar Records
  const sprintAssignmentsRecord: Record<string, Record<string, Issue[]>> = {};
  for (const [assignee, sprintMap] of sprintAssignments) {
    sprintAssignmentsRecord[assignee] = {};
    for (const [sprintId, issues] of sprintMap) {
      sprintAssignmentsRecord[assignee][sprintId.toString()] = issues;
    }
  }

  const sprintHoursRecord: Record<string, Record<string, number>> = {};
  for (const [assignee, sprintMap] of sprintHours) {
    sprintHoursRecord[assignee] = {};
    for (const [sprintId, hours] of sprintMap) {
      sprintHoursRecord[assignee][sprintId.toString()] = hours;
    }
  }

  // At the end of the function, close the logger
  logger.close();

  return {
    issues,
    sprints,
    sprintAssignments: sprintAssignmentsRecord,
    sprintHours: sprintHoursRecord
  };
} 