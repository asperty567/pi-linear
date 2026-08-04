async function issueSummary(issue: any, includeAttachments = false) {
    const [team, state, assignee, attachments] = await Promise.all([
        issue.team,
        issue.state,
        issue.assignee,
        includeAttachments ? issue.attachments({ first: 50 }) : null,
    ]);
    return {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        url: issue.url,
        priority: issue.priorityLabel ?? issue.priority,
        estimate: issue.estimate,
        dueDate: issue.dueDate,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        team: team ? { id: team.id, key: team.key, name: team.name } : null,
        state: state
            ? { id: state.id, name: state.name, type: state.type }
            : null,
        assignee: assignee
            ? { id: assignee.id, name: assignee.name, email: assignee.email }
            : null,
        attachments: (attachments?.nodes ?? []).map((attachment: any) => ({
            id: attachment.id,
            title: attachment.title,
            subtitle: attachment.subtitle,
            url: attachment.url,
            sourceType: attachment.sourceType,
            metadata: attachment.metadata,
            createdAt: attachment.createdAt,
            updatedAt: attachment.updatedAt,
        })),
    };
}

export async function summarizeIssue(issue: any) {
    return issueSummary(issue, true);
}

export async function summarizeIssues(issues: any[]) {
    return Promise.all(issues.map((issue) => issueSummary(issue)));
}
