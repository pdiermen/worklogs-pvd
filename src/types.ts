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
        parent?: {
            key: string;
            fields: {
                summary: string;
            };
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
        customfield_10020?: Array<{
            id: number;
            name: string;
            state: string;
        }>;
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