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
    fields: {
        summary?: string;
        timeestimate?: number;
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
        issuelinks?: IssueLink[];
        parent?: {
            key: string;
        };
        customfield_10020?: Sprint[];
    };
    changelog?: {
        histories: IssueHistory[];
    };
}

export interface WorkLog {
    issueKey: string;
    issueSummary: string;
    author: string;
    timeSpentSeconds: number;
    started: string;
    comment?: string;
    estimatedTime: number;
}

export interface EfficiencyData {
    assignee: string;
    estimated: string;
    logged: string;
    efficiency: string;
}

export interface EfficiencyTable {
    [key: string]: {
        totalTimeSpent: number;
        totalTimeEstimate: number;
        efficiency: number;
    };
}

export interface WorkLogsResponse {
    workLogs: WorkLog[];
    efficiencyTable: EfficiencyData[];
} 