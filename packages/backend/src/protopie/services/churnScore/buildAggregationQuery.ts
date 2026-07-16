import { ParameterError, type Protopie } from '@lightdash/common';

const IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * ChurnZero-faithful source relations (materialized in the data-modeling repo).
 *
 * - EVENT_USAGE_MART: UNION of enterprise/dedicated-cloud and Pro-Plus event
 *   usage, per-account-per-event-per-day, ~372d window, with the synthetic
 *   `editor_activated` event dated at user_created_at. Exposes a canonical
 *   `account_key` (enterprise = the '.protopie' slug of the cloud URL; Pro-Plus
 *   = the SF `account_name`).
 *   Columns consumed: account_key, event_name, event_date (date), user_id,
 *   event_count (instance count).
 * - USER_COUNTS_MART: one row per SF `account_name` = the roster + denominator,
 *   with the matching canonical `account_key` (dbt computes the same slug /
 *   name split, so the two tables join on that single column).
 *   Columns consumed: account_key, sf_account_name, enterprise_url,
 *   distinct_user_count (U), account_owner, sf_plan_category, sf_account_region,
 *   sf_account_country.
 *   Join: event.account_key = user_counts.account_key.
 */
export const EVENT_USAGE_MART = 'protopie_account_event_usage_enterprise_all';
export const USER_COUNTS_MART = 'protopie_account_user_counts';

const validateIdentifier = (value: string, label: string): void => {
    if (!IDENTIFIER_REGEX.test(value)) {
        throw new ParameterError(`Invalid ${label}: ${value}`);
    }
};

export const validateChurnScoreFactorInput = (
    factor: Protopie.ChurnScoreFactorInput,
): void => {
    validateIdentifier(factor.factorKey, 'factor key');

    factor.eventGroup.events.forEach((eventName) => {
        if (
            !eventName ||
            eventName.length > 255 ||
            [...eventName].some((character) => {
                const code = character.charCodeAt(0);
                return code < 32 || code === 127;
            })
        ) {
            throw new ParameterError(
                `Invalid churn score event name for ${factor.factorKey}: ${eventName}`,
            );
        }
    });
};

const buildEventPredicate = ({
    factor,
    values,
}: {
    factor: Protopie.ChurnScoreFactor;
    values: string[];
}): string => {
    if (factor.eventGroup.events.length === 0) {
        return 'FALSE';
    }

    const placeholders = factor.eventGroup.events.map((eventName) => {
        values.push(eventName);
        return `$${values.length}`;
    });

    return `eu.event_name IN (${placeholders.join(', ')})`;
};

const resolveWindowDays = (
    factor: Protopie.ChurnScoreFactor,
    lookbackDays: number,
): number => {
    const windowDays = factor.windowDays ?? lookbackDays;
    if (!Number.isInteger(windowDays) || windowDays <= 0) {
        throw new ParameterError(
            `windowDays must be a positive integer for ${factor.factorKey}.`,
        );
    }
    return windowDays;
};

/**
 * Builds the per-account churn aggregation against the CZ-faithful marts.
 * Account key = the canonical `account_key` (enterprise slug or SF account name;
 * dbt-computed on both marts). Denominator (`total_users`) = the
 * `distinct_user_count` from the SF-account roster. Every account in the roster
 * is scored, even with zero events (LEFT JOIN → NULL metrics → treated as 0 by
 * scoreAccount). Each factor applies its own lookback window.
 */
export const buildAggregationQuery = ({
    schema,
    lookbackDays,
    factors,
}: {
    schema: string;
    lookbackDays: number;
    factors: Protopie.ChurnScoreFactor[];
}): { sql: string; values: string[] } => {
    validateIdentifier(schema, 'warehouse schema');

    if (!Number.isInteger(lookbackDays) || lookbackDays <= 0) {
        throw new ParameterError('lookbackDays must be a positive integer.');
    }

    const values: string[] = [];
    const metrics: { expr: string; alias: string }[] = [];
    let maxWindowDays = lookbackDays;

    factors.forEach((factor) => {
        validateChurnScoreFactorInput(factor);
        const windowDays = resolveWindowDays(factor, lookbackDays);
        maxWindowDays = Math.max(maxWindowDays, windowDays);
        const windowPredicate = `eu.event_date >= CURRENT_DATE - ${windowDays}`;

        if (factor.aggregation === 'active_days') {
            metrics.push({
                alias: 'active_days',
                expr: `COUNT(DISTINCT CASE WHEN ${windowPredicate} THEN eu.event_date END)`,
            });
            return;
        }

        const eventPredicate = buildEventPredicate({ factor, values });
        const predicate = `${eventPredicate} AND ${windowPredicate}`;

        if (factor.aggregation === 'pct_users_with_event') {
            metrics.push({
                alias: `${factor.factorKey}_users`,
                expr: `COUNT(DISTINCT CASE WHEN ${predicate} THEN eu.user_id END)`,
            });
            return;
        }

        // event_count and event_count_per_user both need raw instance totals.
        metrics.push({
            alias: `${factor.factorKey}_event_count`,
            expr: `SUM(CASE WHEN ${predicate} THEN eu.event_count ELSE 0 END)`,
        });
    });

    const innerSelect = metrics
        .map((metric) => `${metric.expr} AS ${metric.alias}`)
        .join(',\n                ');
    const outerSelect = metrics
        .map((metric) => `e.${metric.alias}`)
        .join(',\n            ');

    const sql = `
        WITH event_agg AS (
            SELECT
                eu.account_key,
                ${innerSelect}
            FROM ${schema}.${EVENT_USAGE_MART} eu
            WHERE eu.event_date >= CURRENT_DATE - ${maxWindowDays}
            GROUP BY eu.account_key
        )
        SELECT
            c.account_key AS account_key,
            c.sf_account_name AS namespace,
            c.enterprise_url AS cloud_url,
            c.distinct_user_count AS total_users,
            c.sf_account_name AS sf_account_name,
            c.account_owner AS account_owner,
            c.sf_plan_category AS sf_plan_category,
            c.sf_account_region AS sf_account_region,
            c.sf_account_country AS sf_account_country,
            ${outerSelect}
        FROM ${schema}.${USER_COUNTS_MART} c
        LEFT JOIN event_agg e
            ON e.account_key = c.account_key
    `;

    return { sql, values };
};
