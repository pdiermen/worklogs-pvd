export interface IssueHistory {
    created: string;
    items: {
        field: string;
        toString: string;
    }[];
}

export interface IssueLink {
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

export interface Sprint {
    id: string;
    self: string;
    state: string;
    name: string;
}

export interface Issue {
    key: string;
    fields?: {
        summary?: string;
        timeestimate?: number;
        timeoriginalestimate?: number;
        status?: {
            name: string;
        };
        assignee?: {
            displayName: string;
        };
        priority?: {
            name: string;
        };
        issuetype?: {
            name: string;
        };
        project?: {
            key: string;
            name: string;
        };
        created?: string;
        resolutiondate?: string;
        issuelinks?: IssueLink[];
        parent?: {
            key: string;
        };
        customfield_10020?: Sprint[];
        worklog?: {
            worklogs: Array<{
                author: string | { displayName: string };
                timeSpentSeconds: number;
                started: string;
                comment?: string;
            }>;
        };
    };
    changelog?: {
        histories: IssueHistory[];
    };
}

export interface WorkLog {
    id?: string;
    author: string | { displayName: string; };
    timeSpentSeconds: number;
    started: string;
    issueKey: string;
    comment?: string;
    issueSummary?: string;
    issueStatus?: string;
    issueAssignee?: string;
    issuePriority?: string;
}

export interface EfficiencyData {
    employee: string;
    estimatedHours?: number;
    loggedHours?: number;
    efficiency: number;
    totalHours: number;
    nonWorkingHours: number;
    nonIssueHours: number;
    numberOfIssues: number;
}

export interface EfficiencyTable {
    [key: string]: {
        totalTimeSpent: number;
        totalTimeEstimate: number;
        efficiency: number;
    };
}

export interface WorkLogsSummary {
    employee: string;
    nietGewerkt: string;
    nietOpIssues: string;
    ontwikkeling: string;
    total: string;
}

export interface WorkLogsResponse {
    workLogs: WorkLog[];
    efficiencyTable: EfficiencyData[];
    workLogsSummary: Record<string, WorkLogsSummary[]>;
}

export interface ProjectConfig {
    projectName: string;
    projectCode: string;
    sprintNames: string[];
    employees: string[];
}

export interface WorklogConfig {
    projectName: string;
    columnName: string;
    issues?: string[];
    worklogJql?: string;
}

export interface ProjectData {
    config: ProjectConfig;
    issues: Issue[];
    worklogs: WorkLog[];
    efficiency: EfficiencyData[];
}

export interface JiraIssue {
    id?: string;
    key: string;
    fields: {
        summary: string;
        priority: {
            name: string;
        };
        assignee: {
            displayName: string;
        };
        timeestimate: number;
        status?: {
            name: string;
        };
        timeoriginalestimate?: number;
        worklog?: {
            worklogs: WorkLog[];
        };
    };
}

export interface SprintResult {
    sprint: string;
    hours: number;
    issues: { key: string; hours: number; }[];
}

export interface EmployeeResult {
    name: string;
    hours: number;
    issues: { key: string; hours: number; }[];
    sprintHours: SprintResult[];
}

export interface PlanningResult {
    projectName: string;
    employeeResults: {
        employeeName: string;
        sprintHours: Record<string, number>;
    }[];
    sprintCapacity: number;
    employeeSprintUsedHours: {
        employee: string;
        sprintHours: {
            sprint: string;
            hours: number;
        }[];
    }[];
    plannedIssues: {
        sprint: string;
        issues: {
            key: string;
            summary: string;
            assignee: string;
            hours: number;
        }[];
    }[];
}

export interface Worklog {
    id: string;
    timeSpentSeconds: number;
    started: string;
    author: {
        displayName: string;
    };
    comment?: string;
}

export type GoogleSheetsData = (string | null)[][]; 