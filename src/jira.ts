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
    auth: auth
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
        
        const response = await jiraClient.get('/search', {
            params: {
                jql: 'project = EET AND status != Done AND status != "Ready for testing" ORDER BY priority DESC',
                fields: 'summary,status,assignee,timeestimate,timeoriginalestimate,priority,parent,issuelinks',
                expand: 'names,schema',
                maxResults: 50
            }
        });
        
        console.log('Aantal issues gevonden:', response.data.issues?.length || 0);
        return response.data.issues;
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