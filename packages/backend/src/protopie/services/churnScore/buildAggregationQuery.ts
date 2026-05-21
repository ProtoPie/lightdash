import { ParameterError, type Protopie } from '@lightdash/common';

const IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

    return `ea.event_name IN (${placeholders.join(', ')})`;
};

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
    const metricExpressions: string[] = [
        "COUNT(DISTINCT DATE_TRUNC('day', ea.event_time)) AS active_days",
    ];

    factors.forEach((factor) => {
        validateChurnScoreFactorInput(factor);

        if (factor.aggregation === 'active_days') {
            return;
        }

        const predicate = buildEventPredicate({ factor, values });
        if (factor.aggregation === 'pct_users_with_event') {
            metricExpressions.push(
                `COUNT(DISTINCT CASE WHEN ${predicate} THEN ea.user_id END) AS ${factor.factorKey}_users`,
            );
            return;
        }

        if (factor.aggregation === 'event_count') {
            metricExpressions.push(
                `COALESCE(SUM(CASE WHEN ${predicate} THEN 1 ELSE 0 END), 0) AS ${factor.factorKey}_event_count`,
            );
            return;
        }

        if (factor.aggregation === 'event_count_per_user') {
            metricExpressions.push(
                `COALESCE(SUM(CASE WHEN ${predicate} THEN 1 ELSE 0 END), 0) AS ${factor.factorKey}_event_count`,
            );
        }
    });

    const sql = `
        WITH event_attribution AS (
            SELECT DISTINCT
                e.event_id,
                e.event_time,
                e.event_name,
                e.user_id,
                ep.team_id
            FROM ${schema}.dim_product_all_events e
            LEFT JOIN ${schema}.dim_product_all_event_properties ep
                ON e.event_id = ep.event_id
            WHERE ep.team_id IS NOT NULL
              AND e.event_time >= CURRENT_DATE - ${lookbackDays}
        ),
        enterprise_teams AS (
            SELECT
                t.team_id,
                MAX(t.namespace) AS namespace,
                MAX(t.url) AS cloud_url
            FROM ${schema}.dim_team_summary t
            WHERE t.team_id IS NOT NULL
              AND EXISTS (
                  SELECT 1
                  FROM ${schema}.dim_enterprise_summary es
                  WHERE es.namespace = t.namespace
              )
            GROUP BY t.team_id
        ),
        per_account AS (
            SELECT
                et.team_id AS account_key,
                et.namespace,
                et.cloud_url,
                COUNT(DISTINCT ea.user_id) AS total_users,
                ${metricExpressions.join(',\n                ')}
            FROM enterprise_teams et
            LEFT JOIN event_attribution ea
                ON ea.team_id = et.team_id
            GROUP BY et.team_id, et.namespace, et.cloud_url
        )
        SELECT *
        FROM per_account
    `;

    return { sql, values };
};
