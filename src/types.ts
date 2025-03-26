export interface Issue {
    key: string;
    fields: {
        summary: string;
        status: {
            name: string;
        };
        assignee?: {
            displayName: string;
        };
        customfield_10002?: number;
        timeoriginalestimate?: number;
        timeestimate?: number;
        priority: {
            name: string;
            id: string;
        };
        customfield_10020?: {
            id: number;
            name: string;
            state: string;
            boardId: number;
        }[];
        issuelinks?: IssueLink[];
        parent?: {
            key: string;
            fields: {
                summary: string;
            };
        };
        successors?: string[];
        issuetype: {
            name: string;
        };
    };
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