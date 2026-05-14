import { type Knex } from 'knex';
import { type ClientRepository } from '../../clients/ClientRepository';
import { type ModelRepository } from '../../models/ModelRepository';
import { type ServiceRepository } from '../../services/ServiceRepository';
import { ChurnScoreConfigModel } from '../models/ChurnScoreConfigModel';
import { ChurnScoreFactorModel } from '../models/ChurnScoreFactorModel';
import { ChurnScoreModel } from '../models/ChurnScoreModel';
import { ChurnScoreRunModel } from '../models/ChurnScoreRunModel';
import { FormDefinitionModel } from '../models/FormDefinitionModel';
import { FormSubmissionModel } from '../models/FormSubmissionModel';
import { ProtopieMcpAuditLogModel } from '../models/McpAuditLogModel';
import { ProtopieOrganizationSettingsModel } from '../models/OrganizationSettingsModel';
import { ChurnScoreService } from './ChurnScoreService';
import { FormService } from './FormService';
import { SettingsService } from './SettingsService';

const PROTOPIE_MODELS_CACHE = Symbol.for('lightdash.protopie.models');
const PROTOPIE_SERVICES_CACHE = Symbol.for('lightdash.protopie.services');

type RepositoryWithModels = ServiceRepository & {
    models: ModelRepository;
    clients: ClientRepository;
    [PROTOPIE_SERVICES_CACHE]?: ProtopieServices;
};

type ModelRepositoryWithDatabase = ModelRepository & {
    database: Knex;
    [PROTOPIE_MODELS_CACHE]?: ProtopieModels;
};

export type ProtopieModels = {
    formDefinitionModel: FormDefinitionModel;
    formSubmissionModel: FormSubmissionModel;
    organizationSettingsModel: ProtopieOrganizationSettingsModel;
    mcpAuditLogModel: ProtopieMcpAuditLogModel;
    churnScoreConfigModel: ChurnScoreConfigModel;
    churnScoreFactorModel: ChurnScoreFactorModel;
    churnScoreModel: ChurnScoreModel;
    churnScoreRunModel: ChurnScoreRunModel;
};

export type ProtopieServices = {
    formService: FormService;
    settingsService: SettingsService;
    churnScoreService: ChurnScoreService;
};

export const getProtopieModels = (
    modelRepository: ModelRepository,
): ProtopieModels => {
    const repository = modelRepository as RepositoryWithModels['models'] &
        ModelRepositoryWithDatabase;

    if (!repository[PROTOPIE_MODELS_CACHE]) {
        repository[PROTOPIE_MODELS_CACHE] = {
            formDefinitionModel: new FormDefinitionModel({
                database: repository.database,
            }),
            formSubmissionModel: new FormSubmissionModel({
                database: repository.database,
            }),
            organizationSettingsModel: new ProtopieOrganizationSettingsModel({
                database: repository.database,
            }),
            mcpAuditLogModel: new ProtopieMcpAuditLogModel({
                database: repository.database,
            }),
            churnScoreConfigModel: new ChurnScoreConfigModel({
                database: repository.database,
            }),
            churnScoreFactorModel: new ChurnScoreFactorModel({
                database: repository.database,
            }),
            churnScoreModel: new ChurnScoreModel({
                database: repository.database,
            }),
            churnScoreRunModel: new ChurnScoreRunModel({
                database: repository.database,
            }),
        };
    }

    return repository[PROTOPIE_MODELS_CACHE];
};

export const getProtopieServices = (
    serviceRepository: ServiceRepository,
): ProtopieServices => {
    const repository = serviceRepository as RepositoryWithModels;

    if (!repository[PROTOPIE_SERVICES_CACHE]) {
        const models = getProtopieModels(repository.models);
        const modelRepository =
            repository.models as ModelRepositoryWithDatabase;
        repository[PROTOPIE_SERVICES_CACHE] = {
            formService: new FormService({
                formDefinitionModel: models.formDefinitionModel,
                formSubmissionModel: models.formSubmissionModel,
            }),
            settingsService: new SettingsService({
                organizationSettingsModel: models.organizationSettingsModel,
            }),
            churnScoreService: new ChurnScoreService({
                database: modelRepository.database,
                projectModel: repository.models.getProjectModel(),
                projectService: repository.getProjectService(),
                schedulerClient: repository.clients.getSchedulerClient(),
                churnScoreConfigModel: models.churnScoreConfigModel,
                churnScoreFactorModel: models.churnScoreFactorModel,
                churnScoreModel: models.churnScoreModel,
                churnScoreRunModel: models.churnScoreRunModel,
            }),
        };
    }

    return repository[PROTOPIE_SERVICES_CACHE];
};
