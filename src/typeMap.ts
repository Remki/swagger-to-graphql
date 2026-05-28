// TODO: fix no-param-reassign
/* eslint-disable no-param-reassign */
import {
  GraphQLBoolean,
  GraphQLFieldConfigArgumentMap,
  GraphQLFieldConfigMap,
  GraphQLFloat,
  GraphQLInputFieldConfigMap,
  GraphQLInputObjectType,
  GraphQLInputType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLOutputType,
  GraphQLScalarType,
  GraphQLString
} from 'graphql';
import {
  isArrayType,
  isBodyType,
  isObjectType,
  isRefType,
  JSONSchemaType,
} from './json-schema';
import { EndpointParam } from './getRequestOptions';
import { SwaggerSchema } from './swagger';

export type GraphQLType = GraphQLOutputType | GraphQLInputType | GraphQLList<GraphQLNonNull<GraphQLType>>;;

export interface GraphQLTypeMap {
  [typeName: string]: GraphQLType;
}
const primitiveTypes = {
  string: GraphQLString,
  date: GraphQLString,
  integer: GraphQLInt,
  number: GraphQLFloat,
  boolean: GraphQLBoolean,
};

const jsonType = new GraphQLScalarType({
  name: 'JSON',
  serialize(value) {
    return value;
  },
});

const refRoots = ['definitions', 'components/schemas'];

const getRefSegments = (ref: string): string[] => {
  if (!ref.startsWith('#/')) {
    throw new Error(`Unsupported ref format: ${ref}`);
  }
  return ref.slice(2).split('/');
};

const resolveSchemaRef = (
  swaggerSchema: SwaggerSchema,
  ref: string,
): JSONSchemaType => {
  const resolved = getRefSegments(ref).reduce((result: unknown, segment) => {
    if (!result || typeof result !== 'object' || !(segment in result)) {
      throw new Error(`Unable to resolve ref ${ref}`);
    }
    return (result as { [key: string]: unknown })[segment];
  }, swaggerSchema as unknown);

  return resolved as JSONSchemaType;
};

const getTypeNameFromRef = (ref: string): string => {
  const segments = getRefSegments(ref);
  const refRoot = segments.slice(0, -1).join('/');
  if (!refRoots.includes(refRoot)) {
    throw new Error(`Unsupported ref target: ${ref}`);
  }
  return segments[segments.length - 1];
};

function getPrimitiveType(
  format: string | undefined,
  type: keyof typeof primitiveTypes,
): GraphQLScalarType {
  const primitiveTypeName = format === 'int64' ? 'string' : type;
  const primitiveType = primitiveTypes[primitiveTypeName];
  if (!primitiveType) {
    return primitiveTypes.string;
  }
  return primitiveType;
}

export const jsonSchemaTypeToGraphQL = <IsInputType extends boolean>(
  title: string,
  jsonSchema: JSONSchemaType,
  propertyName: string,
  isInputType: IsInputType,
  gqlTypes: GraphQLTypeMap,
  required: boolean,
  swaggerSchema: SwaggerSchema,
): IsInputType extends true ? GraphQLInputType : GraphQLOutputType => {
  const baseType = ((): GraphQLType => {
    if (isBodyType(jsonSchema)) {
      return jsonSchemaTypeToGraphQL(
        title,
        jsonSchema.schema,
        propertyName,
        isInputType,
        gqlTypes,
        required,
        swaggerSchema,
      );
    }
    if (isRefType(jsonSchema)) {
      return createGraphQLType(
        resolveSchemaRef(swaggerSchema, jsonSchema.$ref),
        getTypeNameFromRef(jsonSchema.$ref),
        isInputType,
        gqlTypes,
        swaggerSchema,
      );
    }
    if (isObjectType(jsonSchema) || isArrayType(jsonSchema)) {
      // eslint-disable-next-line no-use-before-define,@typescript-eslint/no-use-before-define
      return createGraphQLType(
        jsonSchema,
        `${title}_${propertyName}`,
        isInputType,
        gqlTypes,
        swaggerSchema,
      );
    }

    if (jsonSchema.type === 'file') {
      // eslint-disable-next-line no-use-before-define,@typescript-eslint/no-use-before-define
      return createGraphQLType(
        {
          type: 'object',
          required: [],
          properties: { unsupported: { type: 'string' } },
        },
        `${title}_${propertyName}`,
        isInputType,
        gqlTypes,
        swaggerSchema,
      );
    }

    if (jsonSchema.type) {
      return getPrimitiveType(jsonSchema.format, jsonSchema.type);
    }
    throw new Error(
      `Don't know how to handle schema ${JSON.stringify(
        jsonSchema,
      )} without type and schema`,
    );
  })();
  return (required
    ? new GraphQLNonNull(baseType)
    : baseType) as IsInputType extends true
    ? GraphQLInputType
    : GraphQLOutputType;
};

const makeValidName = (name: string): string =>
  name.replace(/[^_0-9A-Za-z]/g, '_');

export type Thunk<T> = (() => T) | T;

export const getTypeFields = (
  jsonSchema: JSONSchemaType,
  title: string,
  isInputType: boolean,
  gqlTypes: GraphQLTypeMap,
  swaggerSchema: SwaggerSchema,
):
  | Thunk<GraphQLInputFieldConfigMap>
  | Thunk<GraphQLFieldConfigMap<any, any>> => {
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  return () => {
    const properties: { [name: string]: JSONSchemaType } = {};
    if (isObjectType(jsonSchema)) {
      Object.keys(jsonSchema.properties).forEach(key => {
        properties[makeValidName(key)] = jsonSchema.properties[key];
      });
    }
    return Object.keys(properties).reduce(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (previousValue: any, propertyName) => {
        const propertySchema = properties[propertyName];
        const type = jsonSchemaTypeToGraphQL(
          title,
          propertySchema,
          propertyName,
          isInputType,
          gqlTypes,
          !!(
            isObjectType(jsonSchema) &&
            jsonSchema.required &&
            jsonSchema.required.includes(propertyName)
          ),
          swaggerSchema,
        );
        return {
          ...previousValue,
          [propertyName]: {
            description: propertySchema.description,
            type,
          },
        };
      },
      {},
    ) as any;
  };
};

export const createGraphQLType = (
  jsonSchema: JSONSchemaType | undefined,
  title: string,
  isInputType: boolean,
  gqlTypes: GraphQLTypeMap,
  swaggerSchema: SwaggerSchema,
): GraphQLType => {
  if (jsonSchema && isRefType(jsonSchema)) {
    return createGraphQLType(
      resolveSchemaRef(swaggerSchema, jsonSchema.$ref),
      getTypeNameFromRef(jsonSchema.$ref),
      isInputType,
      gqlTypes,
      swaggerSchema,
    );
  }

  title = (jsonSchema && jsonSchema.title) || title;
  title = makeValidName(title);

  if (isInputType && !title.endsWith('Input')) {
    title += 'Input';
  }

  if (title in gqlTypes) {
    return gqlTypes[title];
  }

  if (!jsonSchema) {
    jsonSchema = {
      type: 'object',
      properties: {},
      required: [],
      description: '',
      title,
    };
  } else if (!jsonSchema.title) {
    jsonSchema = { ...jsonSchema, title };
  }

  if (isArrayType(jsonSchema)) {
    const itemsSchema = Array.isArray(jsonSchema.items)
      ? jsonSchema.items[0]
      : jsonSchema.items;
    if (
      isRefType(itemsSchema) ||
      isObjectType(itemsSchema) ||
      isArrayType(itemsSchema)
    ) {
      return new GraphQLList(
        new GraphQLNonNull(
          createGraphQLType(
            itemsSchema,
            `${title}_items`,
            isInputType,
            gqlTypes,
            swaggerSchema,
          ),
        ),
      );
    }

    if (itemsSchema.type === 'file') {
      // eslint-disable-next-line no-use-before-define,@typescript-eslint/no-use-before-define
      return new GraphQLList(
        new GraphQLNonNull(
          createGraphQLType(
            {
              type: 'object',
              required: [],
              properties: { unsupported: { type: 'string' } },
            },
            title,
            isInputType,
            gqlTypes,
            swaggerSchema,
          ),
        ),
      );
    }
    const primitiveType = getPrimitiveType(
      itemsSchema.format,
      itemsSchema.type,
    );
    return new GraphQLList(new GraphQLNonNull(primitiveType));
  }

  if (
    isObjectType(jsonSchema) &&
    !Object.keys(jsonSchema.properties || {}).length
  ) {
    return jsonType;
  }

  const { description } = jsonSchema;
  const fields = getTypeFields(
    jsonSchema,
    title,
    isInputType,
    gqlTypes,
    swaggerSchema,
  );
  let result;
  if (isInputType) {
    result = new GraphQLInputObjectType({
      name: title,
      description,
      fields: fields as GraphQLInputFieldConfigMap,
    });
  } else {
    result = new GraphQLObjectType({
      name: title,
      description,
      fields: fields as GraphQLFieldConfigMap<any, any>,
    });
  }
  gqlTypes[title] = result;
  return result;
};

export const mapParametersToFields = (
  parameters: EndpointParam[],
  typeName: string,
  gqlTypes: GraphQLTypeMap,
  swaggerSchema: SwaggerSchema,
): GraphQLFieldConfigArgumentMap => {
  return parameters.reduce((res: GraphQLFieldConfigArgumentMap, param) => {
    const type = jsonSchemaTypeToGraphQL(
      `param_${typeName}`,
      param.jsonSchema,
      param.name,
      true,
      gqlTypes,
      param.required,
      swaggerSchema,
    );
    res[param.name] = {
      type,
    };
    return res;
  }, {});
};
