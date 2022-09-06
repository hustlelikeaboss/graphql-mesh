import { Logger, Maybe, RawSourceOutput, YamlConfig } from '@graphql-mesh/types';
import * as tsBasePlugin from '@graphql-codegen/typescript';
import * as tsResolversPlugin from '@graphql-codegen/typescript-resolvers';
import { GraphQLSchema, GraphQLObjectType, NamedTypeNode, Kind } from 'graphql';
import { codegen } from '@graphql-codegen/core';
import { pascalCase } from 'pascal-case';
import { printSchemaWithDirectives, Source } from '@graphql-tools/utils';
import * as tsOperationsPlugin from '@graphql-codegen/typescript-operations';
import * as typescriptGenericSdk from '@graphql-codegen/typescript-generic-sdk';
import * as typedDocumentNodePlugin from '@graphql-codegen/typed-document-node';
import { fs, path as pathModule } from '@graphql-mesh/cross-helpers';
import ts from 'typescript';
import { pathExists, writeFile, writeJSON } from '@graphql-mesh/utils';
import { generateOperations } from './generate-operations';
import { GraphQLMeshCLIParams } from '..';
import JSON5 from 'json5';
import { resolvers as scalarResolvers } from 'graphql-scalars';

const unifiedContextIdentifier = 'MeshContext';

class CodegenHelpers extends tsBasePlugin.TsVisitor {
  public getTypeToUse(namedType: NamedTypeNode): string {
    if (this.scalars[namedType.name.value]) {
      return this._getScalar(namedType.name.value);
    }

    return this._getTypeForNode(namedType);
  }
}

function buildSignatureBasedOnRootFields(
  codegenHelpers: CodegenHelpers,
  type: Maybe<GraphQLObjectType>,
  namespace: string
): Record<string, string> {
  if (!type) {
    return {};
  }

  const fields = type.getFields();
  const operationMap: Record<string, string> = {};
  for (const fieldName in fields) {
    const field = fields[fieldName];
    const argsExists = field.args && field.args.length > 0;
    const argsName = argsExists ? `${namespace}.${type.name}${field.name}Args` : '{}';
    const parentTypeNode: NamedTypeNode = {
      kind: Kind.NAMED_TYPE,
      name: {
        kind: Kind.NAME,
        value: type.name,
      },
    };

    operationMap[fieldName] = `  /** ${field.description} **/\n  ${
      field.name
    }: InContextSdkMethod<${namespace}.${codegenHelpers.getTypeToUse(
      parentTypeNode
    )}['${fieldName}'], ${argsName}, ${unifiedContextIdentifier}>`;
  }
  return operationMap;
}

async function generateTypesForApi(options: {
  schema: GraphQLSchema;
  name: string;
  contextVariables: Record<string, string>;
  codegenScalarsConfig: Record<string, string>;
}) {
  const baseTypes = await codegen({
    filename: options.name + '_types.ts',
    documents: [],
    config: {
      skipTypename: true,
      namingConvention: 'keep',
      enumsAsTypes: true,
      ignoreEnumValuesFromSchema: true,
      scalars: options.codegenScalarsConfig,
    },
    schemaAst: options.schema,
    schema: undefined as any, // This is not necessary on codegen. Will be removed later
    skipDocumentsValidation: true,
    plugins: [
      {
        typescript: {},
      },
    ],
    pluginMap: {
      typescript: tsBasePlugin,
    },
  });
  const codegenHelpers = new CodegenHelpers(options.schema, {}, {});
  const namespace = pascalCase(`${options.name}Types`);
  const sdkIdentifier = pascalCase(`${options.name}Sdk`);
  const contextIdentifier = pascalCase(`${options.name}Context`);
  const queryOperationMap = buildSignatureBasedOnRootFields(codegenHelpers, options.schema.getQueryType(), namespace);
  const mutationOperationMap = buildSignatureBasedOnRootFields(
    codegenHelpers,
    options.schema.getMutationType(),
    namespace
  );
  const subscriptionsOperationMap = buildSignatureBasedOnRootFields(
    codegenHelpers,
    options.schema.getSubscriptionType(),
    namespace
  );

  const sdk = {
    identifier: sdkIdentifier,
    codeAst: `
import { InContextSdkMethod } from '@graphql-mesh/types';
import { MeshContext } from '@graphql-mesh/runtime';

export namespace ${namespace} {
  ${baseTypes}
}
export type Query${sdkIdentifier} = {
${Object.values(queryOperationMap).join(',\n')}
};

export type Mutation${sdkIdentifier} = {
${Object.values(mutationOperationMap).join(',\n')}
};

export type Subscription${sdkIdentifier} = {
${Object.values(subscriptionsOperationMap).join(',\n')}
};`,
  };

  const context = {
    identifier: contextIdentifier,
    codeAst: `export type ${contextIdentifier} = {
      [${JSON.stringify(
        options.name
      )}]: { Query: Query${sdkIdentifier}, Mutation: Mutation${sdkIdentifier}, Subscription: Subscription${sdkIdentifier} },
      ${Object.keys(options.contextVariables)
        .map(key => `[${JSON.stringify(key)}]: ${options.contextVariables[key]}`)
        .join(',\n')}
    };`,
  };

  const imports = [contextIdentifier];

  return {
    imports,
    sdk,
    context,
  };
}

const BASEDIR_ASSIGNMENT_COMMENT = `/* BASEDIR_ASSIGNMENT */`;

export async function generateTsArtifacts(
  {
    unifiedSchema,
    rawSources,
    mergerType = 'stitching',
    documents,
    flattenTypes,
    importedModulesSet,
    baseDir,
    meshConfigImportCodes,
    meshConfigCodes,
    logger,
    sdkConfig,
    fileType,
    codegenConfig = {},
  }: {
    unifiedSchema: GraphQLSchema;
    rawSources: readonly RawSourceOutput[];
    mergerType: string;
    documents: Source[];
    flattenTypes: boolean;
    importedModulesSet: Set<string>;
    baseDir: string;
    meshConfigImportCodes: Set<string>;
    meshConfigCodes: Set<string>;
    logger: Logger;
    sdkConfig: YamlConfig.SDKConfig;
    fileType: 'ts' | 'json' | 'js';
    codegenConfig: any;
  },
  cliParams: GraphQLMeshCLIParams
) {
  const artifactsDir = pathModule.join(baseDir, cliParams.artifactsDir);
  logger.info('Generating index file in TypeScript');
  for (const rawSource of rawSources) {
    const transformedSchema = (unifiedSchema.extensions as any).sourceMap.get(rawSource);
    const sdl = printSchemaWithDirectives(transformedSchema);
    await writeFile(pathModule.join(artifactsDir, `sources/${rawSource.name}/schema.graphql`), sdl);
  }
  const documentsInput = sdkConfig?.generateOperations
    ? generateOperations(unifiedSchema, sdkConfig.generateOperations)
    : documents;
  const pluginsInput: Record<string, any>[] = [
    {
      typescript: {},
    },
    {
      resolvers: {},
    },
    {
      contextSdk: {},
    },
  ];
  if (documentsInput.length) {
    pluginsInput.push(
      {
        typescriptOperations: {},
      },
      {
        typedDocumentNode: {},
      },
      {
        typescriptGenericSdk: {
          documentMode: 'external',
          importDocumentNodeExternallyFrom: 'NOWHERE',
        },
      }
    );
  }
  const codegenScalarsConfig = {
    File: 'File',
    Upload: 'File',
  };
  for (const resolverName in scalarResolvers) {
    const scalarResolver = scalarResolvers[resolverName];
    codegenScalarsConfig[scalarResolver.name] = scalarResolver.extensions?.codegenScalarType;
  }
  for (const typeName in unifiedSchema.getTypeMap()) {
    const type = unifiedSchema.getType(typeName);
    const codegenScalarType = type.extensions.codegenScalarType;
    if (codegenScalarType) {
      codegenScalarsConfig[typeName] = codegenScalarType;
    }
  }
  const codegenOutput =
    '// @ts-nocheck\n' +
    (
      await codegen({
        filename: 'types.ts',
        documents: documentsInput,
        config: {
          skipTypename: true,
          flattenGeneratedTypes: flattenTypes,
          onlyOperationTypes: flattenTypes,
          preResolveTypes: flattenTypes,
          namingConvention: 'keep',
          documentMode: 'graphQLTag',
          gqlImport: '@graphql-mesh/utils#gql',
          enumsAsTypes: true,
          ignoreEnumValuesFromSchema: true,
          useIndexSignature: true,
          noSchemaStitching: mergerType !== 'stitching',
          contextType: unifiedContextIdentifier,
          federation: mergerType === 'federation',
          scalars: codegenScalarsConfig,
          ...codegenConfig,
        },
        schemaAst: unifiedSchema,
        schema: undefined as any, // This is not necessary on codegen.
        // skipDocumentsValidation: true,
        pluginMap: {
          typescript: tsBasePlugin,
          typescriptOperations: tsOperationsPlugin,
          typedDocumentNode: typedDocumentNodePlugin,
          typescriptGenericSdk,
          resolvers: tsResolversPlugin,
          contextSdk: {
            plugin: async () => {
              const importCodes = new Set([
                ...meshConfigImportCodes,
                `import { getMesh, ExecuteMeshFn, SubscribeMeshFn, MeshContext as BaseMeshContext, MeshInstance } from '@graphql-mesh/runtime';`,
                `import { MeshStore, FsStoreStorageAdapter } from '@graphql-mesh/store';`,
                `import { path as pathModule } from '@graphql-mesh/cross-helpers';`,
              ]);
              const results = await Promise.all(
                rawSources.map(async source => {
                  const sourceMap = unifiedSchema.extensions.sourceMap as Map<RawSourceOutput, GraphQLSchema>;
                  const sourceSchema = sourceMap.get(source);
                  const item = await generateTypesForApi({
                    schema: sourceSchema,
                    name: source.name,
                    contextVariables: source.contextVariables,
                    codegenScalarsConfig,
                  });

                  if (item) {
                    const content = item.sdk.codeAst + '\n' + item.context.codeAst;
                    await writeFile(pathModule.join(artifactsDir, `sources/${source.name}/types.ts`), content);
                    if (item.imports) {
                      importCodes.add(
                        `import type { ${item.imports.join(', ')} } from './sources/${source.name}/types';`
                      );
                    }
                  }
                  return item;
                })
              );

              const contextType = `export type ${unifiedContextIdentifier} = ${results
                .map(r => r?.context?.identifier)
                .filter(Boolean)
                .join(' & ')} & BaseMeshContext;`;

              let meshMethods = `
${BASEDIR_ASSIGNMENT_COMMENT}

const importFn = (moduleId: string) => {
  const relativeModuleId = (pathModule.isAbsolute(moduleId) ? pathModule.relative(baseDir, moduleId) : moduleId).split('\\\\').join('/').replace(baseDir + '/', '');
  switch(relativeModuleId) {${[...importedModulesSet]
    .map(importedModuleName => {
      let moduleMapProp = importedModuleName;
      let importPath = importedModuleName;
      if (importPath.startsWith('.')) {
        importPath = pathModule.join(baseDir, importPath);
      }
      if (pathModule.isAbsolute(importPath)) {
        moduleMapProp = pathModule.relative(baseDir, importedModuleName).split('\\').join('/');
        importPath = `./${pathModule.relative(artifactsDir, importedModuleName).split('\\').join('/')}`;
      }
      return `
    case ${JSON.stringify(moduleMapProp)}:
      return import(${JSON.stringify(importPath)});
    `;
    })
    .join('')}
    default:
      return Promise.reject(new Error(\`Cannot find module '\${relativeModuleId}'.\`));
  }
};

const rootStore = new MeshStore('${cliParams.artifactsDir}', new FsStoreStorageAdapter({
  cwd: baseDir,
  importFn,
  fileType: ${JSON.stringify(fileType)},
}), {
  readonly: true,
  validate: false
});

${[...meshConfigCodes].join('\n')}

let meshInstance$: Promise<MeshInstance<MeshContext>>;

export function ${cliParams.builtMeshFactoryName}(): Promise<MeshInstance<MeshContext>> {
  if (meshInstance$ == null) {
    meshInstance$ = getMeshOptions().then(meshOptions => getMesh<MeshContext>(meshOptions)).then(mesh => {
      const id$ = mesh.pubsub.subscribe('destroy', () => {
        meshInstance$ = undefined;
        id$.then(id => mesh.pubsub.unsubscribe(id)).catch(err => console.error(err));
      });
      return mesh;
    });
  }
  return meshInstance$;
}

export const execute: ExecuteMeshFn = (...args) => ${
                cliParams.builtMeshFactoryName
              }().then(({ execute }) => execute(...args));

export const subscribe: SubscribeMeshFn = (...args) => ${
                cliParams.builtMeshFactoryName
              }().then(({ subscribe }) => subscribe(...args));`;

              if (documentsInput.length) {
                meshMethods += `
export function ${cliParams.builtMeshSDKFactoryName}<TGlobalContext = any, TOperationContext = any>(globalContext?: TGlobalContext) {
  const sdkRequester$ = ${cliParams.builtMeshFactoryName}().then(({ sdkRequesterFactory }) => sdkRequesterFactory(globalContext));
  return getSdk<TOperationContext>((...args) => sdkRequester$.then(sdkRequester => sdkRequester(...args)));
}`;
              }

              return {
                prepend: [[...importCodes].join('\n'), '\n\n'],
                content: [contextType, meshMethods].join('\n\n'),
              };
            },
          },
        },
        plugins: pluginsInput,
      })
    )
      .replace(`import * as Operations from 'NOWHERE';\n`, '')
      .replace(`import { DocumentNode } from 'graphql';`, '');

  const baseUrlAssignmentESM = `import { fileURLToPath } from '@graphql-mesh/utils';
const baseDir = pathModule.join(pathModule.dirname(fileURLToPath(import.meta.url)), '${pathModule.relative(
    artifactsDir,
    baseDir
  )}');`;
  const baseUrlAssignmentCJS = `const baseDir = pathModule.join(typeof __dirname === 'string' ? __dirname : '/', '${pathModule.relative(
    artifactsDir,
    baseDir
  )}');`;

  const tsFilePath = pathModule.join(artifactsDir, 'index.ts');

  const jobs: (() => Promise<void>)[] = [];
  const jsFilePath = pathModule.join(artifactsDir, 'index.js');
  const dtsFilePath = pathModule.join(artifactsDir, 'index.d.ts');

  const esmJob = (ext: 'mjs' | 'js') => async () => {
    logger.info('Writing index.ts for ESM to the disk.');
    await writeFile(tsFilePath, codegenOutput.replace(BASEDIR_ASSIGNMENT_COMMENT, baseUrlAssignmentESM));

    const esmJsFilePath = pathModule.join(artifactsDir, `index.${ext}`);
    if (await pathExists(esmJsFilePath)) {
      await fs.promises.unlink(esmJsFilePath);
    }

    if (fileType !== 'ts') {
      logger.info(`Compiling TS file as ES Module to "index.${ext}"`);
      compileTS(tsFilePath, ts.ModuleKind.ESNext, [jsFilePath, dtsFilePath]);

      if (ext === 'mjs') {
        const mjsFilePath = pathModule.join(artifactsDir, 'index.mjs');
        await fs.promises.rename(jsFilePath, mjsFilePath);
      }

      logger.info('Deleting index.ts');
      await fs.promises.unlink(tsFilePath);
    }
  };

  const cjsJob = async () => {
    logger.info('Writing index.ts for CJS to the disk.');
    await writeFile(tsFilePath, codegenOutput.replace(BASEDIR_ASSIGNMENT_COMMENT, baseUrlAssignmentCJS));

    if (await pathExists(jsFilePath)) {
      await fs.promises.unlink(jsFilePath);
    }
    if (fileType !== 'ts') {
      logger.info('Compiling TS file as CommonJS Module to `index.js`');
      compileTS(tsFilePath, ts.ModuleKind.CommonJS, [jsFilePath, dtsFilePath]);

      logger.info('Deleting index.ts');
      await fs.promises.unlink(tsFilePath);
    }
  };

  const packageJsonJob = (module: string) => () =>
    writeJSON(pathModule.join(artifactsDir, 'package.json'), {
      name: 'mesh-artifacts',
      private: true,
      type: module,
      main: 'index.js',
      module: 'index.mjs',
      sideEffects: false,
      typings: 'index.d.ts',
      typescript: {
        definition: 'index.d.ts',
      },
      exports: {
        '.': {
          require: './index.js',
          import: './index.mjs',
        },
        './*': {
          require: './*.js',
          import: './*.mjs',
        },
      },
    });

  const tsConfigPath = pathModule.join(baseDir, 'tsconfig.json');
  if (await pathExists(tsConfigPath)) {
    const tsConfigStr = await fs.promises.readFile(tsConfigPath, 'utf-8');
    const tsConfig = JSON5.parse(tsConfigStr);
    if (tsConfig?.compilerOptions?.module?.toLowerCase()?.startsWith('es')) {
      jobs.push(esmJob('js'));
      if (fileType !== 'ts') {
        jobs.push(packageJsonJob('module'));
      }
    } else {
      jobs.push(cjsJob);
      if (fileType !== 'ts') {
        jobs.push(packageJsonJob('commonjs'));
      }
    }
  } else {
    jobs.push(esmJob('mjs'));
    if (fileType === 'js') {
      jobs.push(packageJsonJob('module'));
    } else {
      jobs.push(cjsJob);
      jobs.push(packageJsonJob('commonjs'));
    }
  }

  for (const job of jobs) {
    await job();
  }
}

export function compileTS(tsFilePath: string, module: ts.ModuleKind, outputFilePaths: string[]) {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module,
    sourceMap: false,
    inlineSourceMap: false,
    importHelpers: true,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    declaration: true,
  };
  const host = ts.createCompilerHost(options);

  const hostWriteFile = host.writeFile.bind(host);
  host.writeFile = (fileName, ...rest) => {
    if (outputFilePaths.some(f => pathModule.normalize(f) === pathModule.normalize(fileName))) {
      return hostWriteFile(fileName, ...rest);
    }
  };

  // Prepare and emit the d.ts files
  const program = ts.createProgram([tsFilePath], options, host);
  program.emit();
}
