declare module 'dotenv' {
  export function config(options?: { path?: string }): void;
}

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
    issuelinks?: IssueLink[];
    parent?: {
      key: string;
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