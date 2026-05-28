import {
  GraphQLFieldConfig,
  GraphQLFieldConfigMap,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLOutputType,
  GraphQLResolveInfo,
  GraphQLSchema,
} from 'graphql';
import refParser, { JSONSchema } from '@apidevtools/json-schema-ref-parser';
import {
  addTitlesToJsonSchemas,
  Endpoint,
  Endpoints,
  getAllEndPoints,
  GraphQLParameters,
  SwaggerSchema,
} from './swagger';
import {
  GraphQLTypeMap,
  jsonSchemaTypeToGraphQL,
  mapParametersToFields,
} from './typeMap';
import { RequestOptions } from './getRequestOptions';
import { RootGraphQLSchema } from './json-schema';

export function parseResponse(response: any, returnType: GraphQLOutputType) {
  const nullableType =
    returnType instanceof GraphQLNonNull ? returnType.ofType : returnType;
  if (
    nullableType instanceof GraphQLObjectType ||
    nullableType instanceof GraphQLList
  ) {
    return response;
  }

  if (nullableType.name === 'String' && typeof response !== 'string') {
    return JSON.stringify(response);
  }

  return response;
}

const getFields = <TContext>(
  endpoints: Endpoints,
  isMutation: boolean,
  gqlTypes: GraphQLTypeMap,
  swaggerSchema: SwaggerSchema,
  { callBackend }: Options<TContext>,
): GraphQLFieldConfigMap<any, any> => {
  return Object.keys(endpoints)
    .filter((operationId: string) => {
      return !!endpoints[operationId].mutation === !!isMutation;
    })
    .reduce((result, operationId) => {
      const endpoint: Endpoint = endpoints[operationId];
      const type = jsonSchemaTypeToGraphQL(
        operationId,
        endpoint.response || { type: 'object', properties: {} },
        'response',
        false,
        gqlTypes,
        true,
        swaggerSchema,
      );
      const gType: GraphQLFieldConfig<any, any> = {
        type,
        description: endpoint.description || undefined,
        args: mapParametersToFields(
          endpoint.parameters,
          operationId,
          gqlTypes,
          swaggerSchema,
        ),
        resolve: async (
          _source: any,
          args: GraphQLParameters,
          context: TContext,
          info: GraphQLResolveInfo,
        ): Promise<any> => {
          return parseResponse(
            await callBackend({
              context,
              requestOptions: endpoint.getRequestOptions(args),
            }),
            info.returnType,
          );
        },
      };
      return { ...result, [operationId]: gType };
    }, {});
};

const schemaFromEndpoints = <TContext>(
  endpoints: Endpoints,
  swaggerSchema: SwaggerSchema,
  options: Options<TContext>,
): GraphQLSchema => {
  const gqlTypes = {};
  const queryFields = getFields(
    endpoints,
    false,
    gqlTypes,
    swaggerSchema,
    options,
  );
  if (!Object.keys(queryFields).length) {
    throw new Error('Did not find any GET endpoints');
  }
  const rootType = new GraphQLObjectType({
    name: 'Query',
    fields: queryFields,
  });

  const graphQLSchema: RootGraphQLSchema = {
    query: rootType,
  };

  const mutationFields = getFields(
    endpoints,
    true,
    gqlTypes,
    swaggerSchema,
    options,
  );
  if (Object.keys(mutationFields).length) {
    graphQLSchema.mutation = new GraphQLObjectType({
      name: 'Mutation',
      fields: mutationFields,
    });
  }

  return new GraphQLSchema(graphQLSchema);
};

export { RequestOptions, JSONSchema };

export interface CallBackendArguments<TContext> {
  context: TContext;
  requestOptions: RequestOptions;
}

export interface Options<TContext> {
  swaggerSchema: string | JSONSchema;
  callBackend: (args: CallBackendArguments<TContext>) => Promise<any>;
}

export const createSchema = async <TContext>(
  options: Options<TContext>,
): Promise<GraphQLSchema> => {
  const schemaWithoutReferences = (await refParser.bundle(
    options.swaggerSchema,
  )) as SwaggerSchema;
  const swaggerSchema = addTitlesToJsonSchemas(schemaWithoutReferences);
  const endpoints = getAllEndPoints(swaggerSchema);
  return schemaFromEndpoints(endpoints, swaggerSchema, options);
};

export default createSchema;
