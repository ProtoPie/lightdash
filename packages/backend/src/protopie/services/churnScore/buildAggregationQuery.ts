import { ParameterError, type Protopie } from '@lightdash/common';

const IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * ChurnZero-faithful source relations (materialized in the data-modeling repo).
 *
 * - EVENT_USAGE_MART: per-account-per-event-per-day usage, ≥120d, with
 *   Studio events attributed by user_id and Cloud events by Page-URL host,
 *   plus the synthetic `editor_activated` event dated at user_created_at.
 *   Columns consumed: account_url, event_name, event_date (date), user_id,
 *   event_count (instance count).
 * - CONTACTS_MART: one row per account = the CONTACTS roster denominator.
 *   Columns consumed: account_url, namespace, total_contacts (U).
 */
const EVENT_USAGE_MART = 'protopie_account_event_usage';
const CONTACTS_MART = 'protopie_account_contacts';

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
 * Account key = `account_url`. Denominator (`total_users`) = CONTACTS roster
 * (`total_contacts`). Every account in the roster is scored, even with zero
 * events (LEFT JOIN → NULL metrics → treated as 0 by scoreAccount). Each factor
 * applies its own lookback window.
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
                eu.account_url,
                ${innerSelect}
            FROM ${schema}.${EVENT_USAGE_MART} eu
            WHERE eu.event_date >= CURRENT_DATE - ${maxWindowDays}
            GROUP BY eu.account_url
        )
        SELECT
            c.account_url AS account_key,
            c.namespace AS namespace,
            c.account_url AS cloud_url,
            c.total_contacts AS total_users,
            ${outerSelect}
        FROM ${schema}.${CONTACTS_MART} c
        LEFT JOIN event_agg e
            ON e.account_url = c.account_url
    `;

    return { sql, values };
};
