export type ChurnScoreGoalUnit =
    | 'fraction'
    | 'count'
    | 'count_per_user'
    | 'days';

export type ChurnScoreAggregation =
    | 'pct_users_with_event'
    | 'event_count'
    | 'event_count_per_user'
    | 'active_days';

export type ChurnScoreFunction = 'linear';

export type ChurnScoreConfigStatus = 'draft' | 'active' | 'archived';

export type ChurnScoreRunStatus = 'queued' | 'running' | 'completed' | 'failed';

export type ChurnScoreRunTrigger = 'scheduler' | 'manual' | 'mcp';

export type ChurnScoreRiskBand = 'low' | 'medium' | 'high';

export type ChurnScoreSortBy = 'score' | 'risk' | 'namespace' | 'computed_at';

export type ChurnScoreSortDirection = 'asc' | 'desc';

export type ChurnScoreEventGroup = {
    operator: 'or';
    events: string[];
};

export type ChurnScoreRiskBandThresholds = {
    low: number;
    medium: number;
};

export type ChurnScoreFactor = {
    factorUuid?: string;
    configUuid?: string;
    factorKey: string;
    label: string;
    maxPoints: number;
    goalValue: number;
    goalUnit: ChurnScoreGoalUnit;
    aggregation: ChurnScoreAggregation;
    eventGroup: ChurnScoreEventGroup;
    stepThresholds?: Record<string, unknown> | null;
    sortOrder: number;
};

export type ChurnScoreConfig = {
    configUuid: string;
    projectUuid: string;
    name: string;
    version: number;
    lookbackDays: number;
    scoreFunction: ChurnScoreFunction;
    riskBandThresholds: ChurnScoreRiskBandThresholds;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    status: ChurnScoreConfigStatus;
    createdByUserUuid: string | null;
    updatedByUserUuid: string | null;
    createdAt: Date;
    updatedAt: Date;
};

export type ChurnScoreConfigWithFactors = {
    config: ChurnScoreConfig;
    factors: ChurnScoreFactor[];
};

export type ChurnScoreFactorInput = Omit<
    ChurnScoreFactor,
    'factorUuid' | 'configUuid'
>;

export type ChurnScoreConfigInput = {
    name?: string;
    lookbackDays: number;
    scoreFunction: ChurnScoreFunction;
    riskBandThresholds: ChurnScoreRiskBandThresholds;
    factors: ChurnScoreFactorInput[];
};

export type ChurnScoreFactorScore = {
    raw: number;
    goal: number;
    points: number;
};

export type ChurnScoreFactorScores = Record<string, ChurnScoreFactorScore>;

export type ChurnScore = {
    scoreUuid: string;
    projectUuid: string;
    accountKey: string;
    namespace: string | null;
    cloudUrl: string | null;
    scoredForDate: string;
    lookbackDays: number;
    configUuid: string;
    configVersion: number;
    totalPoints: number;
    maxPoints: number;
    scorePercent: number;
    normalizedScore: number;
    riskBand: ChurnScoreRiskBand;
    factorScores: ChurnScoreFactorScores;
    computedAt: Date;
    runUuid: string;
};

export type ChurnScoreFactorDetail = ChurnScoreFactor & {
    score: ChurnScoreFactorScore & {
        achievementPercent: number;
    };
};

export type ChurnScoreAccountEventSummary = {
    eventName: string;
    eventCount: number;
    activeUsers: number;
    activeDays: number;
    shareOfEvents: number;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
};

export type ChurnScoreAccountEventDailyCount = {
    eventDate: string;
    eventName: string;
    eventCount: number;
    activeUsers: number;
};

export type ChurnScoreAccountEventUsage = {
    lookbackDays: number;
    dateFrom: string;
    dateTo: string;
    totalEvents: number;
    selectedEventNames: string[];
    events: ChurnScoreAccountEventSummary[];
    daily: ChurnScoreAccountEventDailyCount[];
};

export type ChurnScoreAccountDetails = {
    score: ChurnScore;
    config: ChurnScoreConfig;
    factors: ChurnScoreFactorDetail[];
    eventUsage: ChurnScoreAccountEventUsage;
};

export type ChurnScoreRun = {
    runUuid: string;
    projectUuid: string;
    configUuid: string;
    triggeredBy: ChurnScoreRunTrigger;
    triggeredByUserUuid: string | null;
    status: ChurnScoreRunStatus;
    startedAt: Date | null;
    finishedAt: Date | null;
    accountsScored: number;
    errorMessage: string | null;
    createdAt: Date;
};

export type ChurnScoreLatestFilters = {
    configUuid?: string;
    riskBand?: ChurnScoreRiskBand;
    minScore?: number;
    maxScore?: number;
    namespace?: string;
    sortBy?: ChurnScoreSortBy;
    sortDirection?: ChurnScoreSortDirection;
    limit?: number;
    offset?: number;
};
