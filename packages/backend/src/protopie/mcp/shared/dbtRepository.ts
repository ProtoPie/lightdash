import { ParameterError } from '@lightdash/common';
import fs from 'fs/promises';
import path from 'path';

const DEFAULT_GITHUB_OWNER = 'ProtoPie';
const DEFAULT_GITHUB_REPO = 'data-modeling';
const DEFAULT_GITHUB_REF = 'main';
const MAX_FILE_BYTES = 300_000;
const DEFAULT_ALLOWED_PATHS = [
    'models',
    'marts',
    'macros',
    'seeds',
    'snapshots',
    'analyses',
    'analysis',
    'tests',
    'dbt_project.yml',
    'packages.yml',
    'selectors.yml',
    'exposures.yml',
    'README.md',
];
const TEXT_FILE_EXTENSIONS = new Set([
    '.sql',
    '.yml',
    '.yaml',
    '.md',
    '.csv',
    '.json',
    '.txt',
]);

type DbtRepositorySource =
    | {
          type: 'local';
          localPath: string;
          allowedPaths: string[];
      }
    | {
          type: 'github';
          owner: string;
          repo: string;
          ref: string;
          token?: string;
          allowedPaths: string[];
      };

type SafeDbtRepositorySource =
    | Extract<DbtRepositorySource, { type: 'local' }>
    | Omit<Extract<DbtRepositorySource, { type: 'github' }>, 'token'>;

export type DbtRepositoryFileSummary = {
    path: string;
    size?: number;
    source: DbtRepositorySource['type'];
};

export type DbtRepositoryFile = DbtRepositoryFileSummary & {
    content: string;
    truncated: boolean;
};

type GitHubTreeResponse = {
    tree?: Array<{
        path?: string;
        type?: string;
        size?: number;
    }>;
};

type GitHubContentResponse = {
    type?: string;
    path?: string;
    size?: number;
    encoding?: string;
    content?: string;
    download_url?: string | null;
};

const splitCsv = (value: string | undefined): string[] =>
    value
        ?.split(',')
        .map((item) => item.trim())
        .filter(Boolean) ?? [];

const normalizeRepoPath = (rawPath?: string): string => {
    const normalized = path.posix.normalize(
        (rawPath ?? '').replace(/\\/g, '/'),
    );
    const withoutLeadingSlash = normalized.replace(/^\/+/, '');

    if (withoutLeadingSlash === '..' || withoutLeadingSlash.startsWith('../')) {
        throw new ParameterError('dbt repository path cannot escape the repo.');
    }

    return withoutLeadingSlash === '.' ? '' : withoutLeadingSlash;
};

const getAllowedPaths = (): string[] => {
    const configured = splitCsv(process.env.PROTOPIE_DBT_ALLOWED_PATHS);
    return (configured.length > 0 ? configured : DEFAULT_ALLOWED_PATHS).map(
        normalizeRepoPath,
    );
};

const getDbtRepositorySource = (): DbtRepositorySource => {
    const allowedPaths = getAllowedPaths();
    const localPath = process.env.PROTOPIE_DBT_LOCAL_PATH;

    if (localPath) {
        return {
            type: 'local',
            localPath,
            allowedPaths,
        };
    }

    return {
        type: 'github',
        owner: process.env.PROTOPIE_DBT_GITHUB_OWNER ?? DEFAULT_GITHUB_OWNER,
        repo: process.env.PROTOPIE_DBT_GITHUB_REPO ?? DEFAULT_GITHUB_REPO,
        ref: process.env.PROTOPIE_DBT_GITHUB_REF ?? DEFAULT_GITHUB_REF,
        token: process.env.PROTOPIE_DBT_GITHUB_TOKEN,
        allowedPaths,
    };
};

const toSafeDbtRepositorySource = (
    source: DbtRepositorySource,
): SafeDbtRepositorySource => {
    if (source.type === 'local') {
        return source;
    }

    return {
        type: 'github',
        owner: source.owner,
        repo: source.repo,
        ref: source.ref,
        allowedPaths: source.allowedPaths,
    };
};

const isAllowedPath = (repoPath: string, allowedPaths: string[]): boolean => {
    if (!repoPath) return true;

    return allowedPaths.some((allowedPath) => {
        if (allowedPath === repoPath) return true;
        return repoPath.startsWith(`${allowedPath.replace(/\/$/, '')}/`);
    });
};

const canReadOrDescendPath = (
    repoPath: string,
    allowedPaths: string[],
): boolean =>
    isAllowedPath(repoPath, allowedPaths) ||
    allowedPaths.some((allowedPath) =>
        allowedPath.startsWith(`${repoPath.replace(/\/$/, '')}/`),
    );

const assertAllowedPath = (repoPath: string, allowedPaths: string[]): void => {
    if (!isAllowedPath(repoPath, allowedPaths)) {
        throw new ParameterError(
            `Path "${repoPath}" is outside the allowed dbt repository paths.`,
        );
    }
};

const isTextFile = (repoPath: string): boolean =>
    TEXT_FILE_EXTENSIONS.has(path.extname(repoPath).toLowerCase());

const toLocalAbsolutePath = (
    source: Extract<DbtRepositorySource, { type: 'local' }>,
    repoPath: string,
): string => {
    const root = path.resolve(source.localPath);
    const absolutePath = path.resolve(root, repoPath);

    if (
        absolutePath !== root &&
        !absolutePath.startsWith(`${root}${path.sep}`)
    ) {
        throw new ParameterError('dbt repository path cannot escape the root.');
    }

    return absolutePath;
};

const walkLocalFiles = async (
    source: Extract<DbtRepositorySource, { type: 'local' }>,
    repoPath: string,
): Promise<DbtRepositoryFileSummary[]> => {
    const absolutePath = toLocalAbsolutePath(source, repoPath);
    const stat = await fs.stat(absolutePath);

    if (stat.isFile()) {
        return [
            {
                path: repoPath,
                size: stat.size,
                source: 'local',
            },
        ];
    }

    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    const files = await Promise.all(
        entries
            .filter((entry) => entry.name !== 'target' && entry.name !== '.git')
            .map((entry) => {
                const childPath = normalizeRepoPath(
                    path.posix.join(repoPath, entry.name),
                );

                if (!canReadOrDescendPath(childPath, source.allowedPaths)) {
                    return Promise.resolve([]);
                }

                if (entry.isDirectory()) {
                    return walkLocalFiles(source, childPath);
                }

                if (!entry.isFile()) return Promise.resolve([]);

                return fs
                    .stat(toLocalAbsolutePath(source, childPath))
                    .then((childStat) => [
                        {
                            path: childPath,
                            size: childStat.size,
                            source: 'local' as const,
                        },
                    ]);
            }),
    );

    return files.flat();
};

const githubHeaders = (
    source: Extract<DbtRepositorySource, { type: 'github' }>,
): Record<string, string> => ({
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'protopie-lightdash-mcp',
    ...(source.token ? { Authorization: `Bearer ${source.token}` } : {}),
});

const fetchGitHubJson = async <T>(
    source: Extract<DbtRepositorySource, { type: 'github' }>,
    apiPath: string,
): Promise<T> => {
    const response = await fetch(`https://api.github.com${apiPath}`, {
        headers: githubHeaders(source),
    });

    if (!response.ok) {
        throw new ParameterError(
            `GitHub dbt repository request failed with ${response.status}: ${await response.text()}`,
        );
    }

    return (await response.json()) as T;
};

const listGitHubFiles = async (
    source: Extract<DbtRepositorySource, { type: 'github' }>,
    repoPath: string,
): Promise<DbtRepositoryFileSummary[]> => {
    const tree = await fetchGitHubJson<GitHubTreeResponse>(
        source,
        `/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(
            source.repo,
        )}/git/trees/${encodeURIComponent(source.ref)}?recursive=1`,
    );

    return (tree.tree ?? [])
        .filter((item) => item.type === 'blob' && item.path)
        .map((item) => ({
            path: normalizeRepoPath(item.path),
            size: item.size,
            source: 'github' as const,
        }))
        .filter(
            (item) =>
                item.path === repoPath || item.path.startsWith(`${repoPath}/`),
        )
        .filter((item) => isAllowedPath(item.path, source.allowedPaths));
};

export const listDbtRepositoryFiles = async ({
    path: rawPath,
    maxFiles = 250,
}: {
    path?: string;
    maxFiles?: number;
}): Promise<{
    source: SafeDbtRepositorySource;
    files: DbtRepositoryFileSummary[];
    total: number;
}> => {
    const source = getDbtRepositorySource();
    const repoPath = normalizeRepoPath(rawPath);
    assertAllowedPath(repoPath, source.allowedPaths);

    const allFiles =
        source.type === 'local'
            ? await walkLocalFiles(source, repoPath)
            : await listGitHubFiles(source, repoPath);

    const files = allFiles
        .filter((file) => isAllowedPath(file.path, source.allowedPaths))
        .sort((a, b) => a.path.localeCompare(b.path));

    return {
        source: toSafeDbtRepositorySource(source),
        files: files.slice(0, maxFiles),
        total: files.length,
    };
};

export const getDbtRepositoryFile = async (
    rawPath: string,
): Promise<DbtRepositoryFile> => {
    const source = getDbtRepositorySource();
    const repoPath = normalizeRepoPath(rawPath);
    assertAllowedPath(repoPath, source.allowedPaths);

    if (!isTextFile(repoPath)) {
        throw new ParameterError(
            `Path "${repoPath}" is not an allowed text dbt source file.`,
        );
    }

    if (source.type === 'local') {
        const absolutePath = toLocalAbsolutePath(source, repoPath);
        const buffer = await fs.readFile(absolutePath);
        return {
            path: repoPath,
            size: buffer.byteLength,
            source: 'local',
            content: buffer.toString('utf8').slice(0, MAX_FILE_BYTES),
            truncated: buffer.byteLength > MAX_FILE_BYTES,
        };
    }

    const encodedPath = repoPath.split('/').map(encodeURIComponent).join('/');
    const response = await fetchGitHubJson<GitHubContentResponse>(
        source,
        `/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(
            source.repo,
        )}/contents/${encodedPath}?ref=${encodeURIComponent(source.ref)}`,
    );

    if (response.type !== 'file') {
        throw new ParameterError(`Path "${repoPath}" is not a file.`);
    }

    const content =
        response.encoding === 'base64' && response.content
            ? Buffer.from(response.content.replace(/\n/g, ''), 'base64')
            : Buffer.from('');

    return {
        path: repoPath,
        size: response.size,
        source: 'github',
        content: content.toString('utf8').slice(0, MAX_FILE_BYTES),
        truncated: (response.size ?? content.byteLength) > MAX_FILE_BYTES,
    };
};

export const searchDbtRepositoryFiles = async ({
    query,
    path: rawPath,
    includeContent = false,
    maxFiles = 50,
}: {
    query: string;
    path?: string;
    includeContent?: boolean;
    maxFiles?: number;
}): Promise<{
    query: string;
    matches: Array<
        DbtRepositoryFileSummary & {
            matchedIn: Array<'path' | 'content'>;
            preview?: string;
        }
    >;
}> => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
        throw new ParameterError('Search query is required.');
    }

    const listed = await listDbtRepositoryFiles({
        path: rawPath,
        maxFiles: 1_000,
    });

    const matches = await listed.files.reduce<
        Promise<
            Array<
                DbtRepositoryFileSummary & {
                    matchedIn: Array<'path' | 'content'>;
                    preview?: string;
                }
            >
        >
    >(async (previousMatches, file) => {
        const accumulatedMatches = await previousMatches;
        if (accumulatedMatches.length >= maxFiles) {
            return accumulatedMatches;
        }

        const matchedIn: Array<'path' | 'content'> = [];
        let preview: string | undefined;

        if (file.path.toLowerCase().includes(normalizedQuery)) {
            matchedIn.push('path');
        }

        if (
            includeContent &&
            isTextFile(file.path) &&
            (file.size ?? 0) <= MAX_FILE_BYTES
        ) {
            const content = await getDbtRepositoryFile(file.path);
            const lowerContent = content.content.toLowerCase();
            const index = lowerContent.indexOf(normalizedQuery);

            if (index >= 0) {
                matchedIn.push('content');
                preview = content.content.slice(
                    Math.max(0, index - 160),
                    index + normalizedQuery.length + 160,
                );
            }
        }

        if (matchedIn.length > 0) {
            accumulatedMatches.push({
                ...file,
                matchedIn,
                preview,
            });
        }

        return accumulatedMatches;
    }, Promise.resolve([]));

    return {
        query,
        matches,
    };
};
