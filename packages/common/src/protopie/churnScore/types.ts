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

export type ChurnScoreFunction = 'linear' | 'stepwise';

export type ChurnScoreConfigStatus =
    | 'draft'
    | 'active'
    | 'archived'
    // Soft-delete marker. A deleted rubric keeps its rows (and the churn scores
    // that FK-reference them) for audit/history, but is excluded from every
    // active-status query so it disappears from the editor and name lookups.
    | 'deleted';

export type ChurnScoreRunStatus =
    | 'queued'
    | 'running'
    | 'completed'
    | 'failed'
    | 'skipped';

export type ChurnScoreRunTrigger = 'scheduler' | 'manual' | 'mcp';

export type ChurnScoreRiskBand = 'low' | 'medium' | 'high';

export type ChurnScoreSortBy = 'score' | 'risk' | 'namespace' | 'computed_at';

export type ChurnScoreSortDirection = 'asc' | 'desc';

export type ChurnScoreEventGroup = {
    operator: 'or';
    events: string[];
};

/**
 * One bucket in a ChurnZero-style step allocation. `bottom` is the inclusive
 * lower edge the raw value is compared against (truncate semantics — no
 * round-up); `top` is the inclusive upper edge for display/validation only;
 * `points` is the integer allocated points awarded when the raw value lands in
 * this bucket. Evaluation picks the range with the greatest `bottom <= raw`.
 */
export type ChurnScoreStepRange = {
    bottom: number;
    top: number | null;
    points: number;
};

export type ChurnScoreStepThresholds = {
    ranges: ChurnScoreStepRange[];
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
    stepThresholds: ChurnScoreStepThresholds | null;
    /**
     * Per-factor lookback window in days. Null falls back to the config-level
     * lookbackDays. ChurnZero parity: most factors 90, `% activated` 120.
     */
    windowDays: number | null;
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

export type RenameChurnScoreConfigInput = {
    currentName: string;
    newName: string;
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
    /** Salesforce account display name (user-facing label). */
    sfAccountName: string | null;
    /** Salesforce account owner (sales rep) — filterable. */
    accountOwner: string | null;
    /** Salesforce plan category — filterable. */
    sfPlanCategory: string | null;
    /** Salesforce account region — filterable. */
    sfAccountRegion: string | null;
    /** Salesforce account country — filterable. */
    sfAccountCountry: string | null;
    scoredForDate: string;
    lookbackDays: number;
    configUuid: string;
    configVersion: number;
    totalPoints: number;
    maxPoints: number;
    scorePercent: number;
    /** Engagement health, 0-100 (= ChurnZero "Total"). Higher = healthier. */
    normalizedScore: number;
    /** Churn risk, 0-100 (= 100 - normalizedScore, the ChurnZero "ChurnScore"). Higher = more at risk. */
    churnScore: number;
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
    /**
     * Inclusive bounds of the selectable date window for this account's Event
     * usage explorer, derived from the mart-wide latest `event_date` and the
     * 90-day window. The UI clamps the date pickers to this range.
     */
    minSelectableDate: string;
    maxSelectableDate: string;
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
    /**
     * Free-text search across the account label + all 4 SF attributes
     * (sf_account_name, namespace, cloud_url, account_owner, sf_plan_category,
     * sf_account_region, sf_account_country). Partial, case-insensitive.
     */
    search?: string;
    /**
     * Multi-select SF filters (IN semantics). Empty/absent = unfiltered.
     * Include CHURN_SCORE_FILTER_NONE_VALUE to also match rows where the
     * attribute is null (the "(none)" bucket).
     */
    accountOwner?: string[];
    sfPlanCategory?: string[];
    sfAccountRegion?: string[];
    sfAccountCountry?: string[];
    sortBy?: ChurnScoreSortBy;
    sortDirection?: ChurnScoreSortDirection;
    limit?: number;
    offset?: number;
};

/** The four SF-attribute facets that drive the churn-scores filter dropdowns. */
export type ChurnScoreFacetKey =
    | 'accountOwner'
    | 'sfPlanCategory'
    | 'sfAccountRegion'
    | 'sfAccountCountry';

/** One selectable value in a facet, with its result count under the other active filters. */
export type ChurnScoreFacetOption = {
    value: string;
    count: number;
};

/**
 * A single filter facet: the available values (with counts) plus the count of
 * rows where the attribute is null (the "(none)" bucket). Counts are computed
 * with every OTHER active filter applied but NOT this facet's own selection, so
 * the user can still broaden a facet they have already touched (standard
 * faceted-search semantics).
 */
export type ChurnScoreFacet = {
    options: ChurnScoreFacetOption[];
    noneCount: number;
};

/**
 * Faceted values for the churn-scores screen filter dropdowns, per config.
 * NOTE: reflects the last recompute (the persisted score snapshot), not live
 * Salesforce — values lag until the next recompute run.
 */
export type ChurnScoreFilterOptions = {
    accountOwner: ChurnScoreFacet;
    sfPlanCategory: ChurnScoreFacet;
    sfAccountRegion: ChurnScoreFacet;
    sfAccountCountry: ChurnScoreFacet;
};
