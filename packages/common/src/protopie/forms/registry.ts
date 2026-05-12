import { ParameterError } from '../../types/errors';
import {
    toClientFormDefinition,
    type ProtopieClientFormDefinition,
    type ProtopieFormDefinition,
} from './defineForm';
import { churnScoreInputForm } from './schemas/churnScoreInput';

export const PROTOPIE_FORM_REGISTRY = [
    churnScoreInputForm,
] as const satisfies readonly ProtopieFormDefinition[];

export type ProtopieFormKey = (typeof PROTOPIE_FORM_REGISTRY)[number]['key'];

export const getProtopieFormDefinition = (
    formKey: string,
): ProtopieFormDefinition => {
    const form = PROTOPIE_FORM_REGISTRY.find(
        (definition) => definition.key === formKey,
    );

    if (!form) {
        throw new ParameterError(`Unknown Protopie form: ${formKey}`);
    }

    return form;
};

export const getProtopieClientFormDefinitions =
    (): ProtopieClientFormDefinition[] =>
        PROTOPIE_FORM_REGISTRY.map(toClientFormDefinition);
