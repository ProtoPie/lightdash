import { type PromotionChanges } from '@lightdash/common';

export const summarizePromotionChanges = (changes: PromotionChanges) => ({
    spaces: changes.spaces.map(({ action, data }) => ({
        action,
        uuid: data.uuid,
        name: data.name,
        slug: data.slug,
    })),
    dashboards: changes.dashboards.map(({ action, data }) => ({
        action,
        uuid: data.uuid,
        name: data.name,
        slug: data.slug,
        spaceSlug: data.spaceSlug,
    })),
    charts: changes.charts.map(({ action, data }) => ({
        action,
        uuid: data.uuid,
        name: data.name,
        slug: data.slug,
        spaceSlug: data.spaceSlug,
    })),
    sqlCharts: (changes.sqlCharts ?? []).map(({ action, data }) => ({
        action,
        uuid: data.uuid,
        name: data.name,
        slug: data.slug,
        spaceSlug: data.spaceSlug,
    })),
});
