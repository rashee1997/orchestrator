import { MemoryManager } from '../../database/memory_manager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { validate } from '../../utils/validation.js';
import { formatSimpleMessage, formatJsonToMarkdownCodeBlock } from '../../utils/formatters.js';
import { CodebaseIntrospectionService, ScannedItem, ExtractedImport, ExtractedCodeEntity } from '../../database/services/CodebaseIntrospectionService.js';
import { GraphTraversalNode } from '../../types/query.js';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import {
    createCanonicalAbsPathKey,
    findActualFilePath,
    haveObservationsChanged,
    countSuccessfulOperations,
    NodeCache,
    getCachedNode,
    upsertCacheNode,
    preloadExistingNodes,
    runWithConcurrency,
    computeFileContentHash
} from './utils.js';

// ============================================================================
// Ingestion Helper Functions
// ============================================================================

async function processExtractedEntity(
    entity: ExtractedCodeEntity,
    fileNodeRelativeName: string,
    existingNodesCache: NodeCache,
    entitiesToCreateBatch: Array<{ name: string; entityType: string; observations: string[] }>,
    observationsToUpdateBatchKG: Array<{ entityName: string; contents: string[] }>,
    relationsToCreateSetKG: Set<string>
) {
    const currentObservations = [
        `type: ${entity.type}`,
        `signature: ${entity.signature || 'N/A'}`,
        `lines: ${entity.startLine}-${entity.endLine}`,
        `exported: ${entity.isExported ? 'yes' : 'no'}`,
        `defined_in_file_path: ${fileNodeRelativeName}`
    ];

    if (entity.docstring) currentObservations.push(`docstring: ${entity.docstring.substring(0, 200)}${entity.docstring.length > 200 ? '...' : ''}`);
    if (entity.parameters && entity.parameters.length > 0) currentObservations.push(`parameters: ${JSON.stringify(entity.parameters)}`);
    if (entity.returnType) currentObservations.push(`return_type: ${entity.returnType}`);
    if (entity.parentClass && entity.filePath) currentObservations.push(`parent_class_full_name: ${entity.filePath}::${entity.parentClass}`);
    if (entity.implementedInterfaces && entity.implementedInterfaces.length > 0) currentObservations.push(`implements: ${entity.implementedInterfaces.join(', ')}`);

    if (entity.calls && entity.calls.length > 0) {
        currentObservations.push(`calls: ${JSON.stringify(entity.calls.map(c => c.name))}`);
    }

    const existingEntityNode = entity.fullName ? getCachedNode(existingNodesCache, entity.fullName, entity.type) : undefined;

    if (existingEntityNode) {
        if (haveObservationsChanged(existingEntityNode.observations, currentObservations)) {
            const newObsToAdd = currentObservations.filter(obs => !(existingEntityNode.observations || []).includes(obs));
            if (newObsToAdd.length > 0) {
                observationsToUpdateBatchKG.push({ entityName: existingEntityNode.name, contents: newObsToAdd });
                upsertCacheNode(existingNodesCache, {
                    ...existingEntityNode,
                    observations: Array.from(new Set([...(existingEntityNode.observations || []), ...newObsToAdd]))
                });
            }
        }
    } else {
        entitiesToCreateBatch.push({
            name: entity.fullName || '',
            entityType: entity.type as string,
            observations: currentObservations,
        });
        if (entity.fullName) {
            upsertCacheNode(existingNodesCache, {
                node_id: `pending:${entity.fullName}`,
                name: entity.fullName,
                entityType: entity.type,
                observations: currentObservations
            });
        }
    }

    if (entity.fullName && fileNodeRelativeName) {
        const defRelKey = { from: entity.fullName, to: fileNodeRelativeName, type: 'defined_in_file' };
        relationsToCreateSetKG.add(JSON.stringify(defRelKey));
    }

    if (entity.type === 'method' && entity.parentClass && entity.fullName && fileNodeRelativeName) {
        const classFullName = `${fileNodeRelativeName}::${entity.parentClass}`;
        const methodRelKey = { from: classFullName, to: entity.fullName, type: 'has_method' };
        relationsToCreateSetKG.add(JSON.stringify(methodRelKey));
    }

    // Infer 'calls_function' or 'calls_method' relations
    if (entity.calls && entity.calls.length > 0 && entity.fullName && fileNodeRelativeName) {
        for (const call of entity.calls) {
            // For now, assume called entities are within the same file or are global functions/methods.
            // A more advanced approach would involve resolving the full path of the called entity.
            const calledEntityFullName = `${fileNodeRelativeName}::${call.name}`;
            const callRelKey = { from: entity.fullName, to: calledEntityFullName, type: `calls_${call.type}` };
            relationsToCreateSetKG.add(JSON.stringify(callRelKey));
        }
    }

    // Infer 'implements_interface' relations
    if (entity.type === 'class' && entity.implementedInterfaces && entity.implementedInterfaces.length > 0 && entity.fullName && fileNodeRelativeName) {
        for (const implementedInterface of entity.implementedInterfaces) {
            const interfaceFullName = `${fileNodeRelativeName}::${implementedInterface}`; // Assuming interface is in the same file
            const implementsRelKey = { from: entity.fullName, to: interfaceFullName, type: 'implements_interface' };
            relationsToCreateSetKG.add(JSON.stringify(implementsRelKey));
        }
    }
}

async function processRootDirectory(
    resolvedProjectRootPath: string,
    existingNodesCache: NodeCache,
    createdOrExistingNodeNamesByCanonicalAbsPath: { [canonicalAbsPathKey: string]: string },
    absolutePathToRelativeNameMap: { [canonicalAbsPathKey: string]: string },
    entitiesToCreateBatch: Array<{ name: string; entityType: string; observations: string[] }>,
    observationsToUpdateBatch: Array<{ entityName: string; contents: string[] }>
) {
    const rootNodeName = "."; // KG node name for the root
    const canonicalRootPathKey = createCanonicalAbsPathKey(resolvedProjectRootPath);

    try {
        const rootStats = await fs.stat(resolvedProjectRootPath);
        const rootObservations = [
            `absolute_path: ${canonicalRootPathKey}`,
            `type: directory`,
            `size_bytes: ${rootStats.size.toString()}`,
            `created_at: ${rootStats.birthtime.toISOString()}`,
            `modified_at: ${rootStats.mtime.toISOString()}`,
        ];

        const existingRootNode = getCachedNode(existingNodesCache, rootNodeName, 'directory');

        if (existingRootNode) {
            createdOrExistingNodeNamesByCanonicalAbsPath[canonicalRootPathKey] = rootNodeName;
            absolutePathToRelativeNameMap[canonicalRootPathKey] = rootNodeName;

            if (haveObservationsChanged(existingRootNode.observations, rootObservations)) {
                observationsToUpdateBatch.push({ entityName: rootNodeName, contents: rootObservations });
                upsertCacheNode(existingNodesCache, {
                    ...existingRootNode,
                    observations: Array.from(new Set([...(existingRootNode.observations || []), ...rootObservations]))
                });
            }
        } else {
            entitiesToCreateBatch.push({ name: rootNodeName, entityType: 'directory', observations: rootObservations });
            createdOrExistingNodeNamesByCanonicalAbsPath[canonicalRootPathKey] = rootNodeName;
            absolutePathToRelativeNameMap[canonicalRootPathKey] = rootNodeName;
            upsertCacheNode(existingNodesCache, {
                node_id: `pending:${rootNodeName}`,
                name: rootNodeName,
                entityType: 'directory',
                observations: rootObservations
            });
        }
    } catch (statError: any) {
        console.warn(`[ingest_codebase_structure] Could not stat project root path ${resolvedProjectRootPath}: ${statError.message}`);
    }
}

async function processScannedItem(
    item: ScannedItem,
    resolvedProjectRootPath: string,
    canonicalEffectiveRootPath: string,
    existingNodesCache: NodeCache,
    createdOrExistingNodeNamesByCanonicalAbsPath: { [canonicalAbsPathKey: string]: string },
    absolutePathToRelativeNameMap: { [canonicalAbsPathKey: string]: string },
    entitiesToCreateBatch: Array<{ name: string; entityType: string; observations: string[] }>,
    observationsToUpdateBatch: Array<{ entityName: string; contents: string[] }>,
    relationsToCreateSet: Set<string>
) {
    // item.name is already relative (to resolvedProjectRootPath) and uses forward slashes from scanDirectoryRecursive
    const entityName = item.name === "" ? "." : item.name;
    const canonicalItemAbsPathKey = createCanonicalAbsPathKey(item.path); // item.path is absolute

    const currentObservations = [
        `absolute_path: ${canonicalItemAbsPathKey}`,
        `type: ${item.type}`,
        `size_bytes: ${item.stats.size.toString()}`,
        `created_at: ${item.stats.birthtime.toISOString()}`,
        `modified_at: ${item.stats.mtime.toISOString()}`,
    ];

    if (item.type === 'file' && item.language) {
        currentObservations.push(`language: ${item.language}`);
    }

    const existingNode = getCachedNode(existingNodesCache, entityName, item.type);

    if (existingNode) {
        createdOrExistingNodeNamesByCanonicalAbsPath[canonicalItemAbsPathKey] = existingNode.name;
        absolutePathToRelativeNameMap[canonicalItemAbsPathKey] = existingNode.name;

        if (item.language === 'typescript' && item.path.endsWith('.ts')) {
            const jsPathKey = createCanonicalAbsPathKey(item.path.slice(0, -3) + '.js');
            absolutePathToRelativeNameMap[jsPathKey] = existingNode.name;
        }

        if (haveObservationsChanged(existingNode.observations, currentObservations)) {
            const newObsToAdd = currentObservations.filter(obs => !(existingNode.observations || []).includes(obs));
            if (newObsToAdd.length > 0) {
                observationsToUpdateBatch.push({ entityName: existingNode.name, contents: newObsToAdd });
                upsertCacheNode(existingNodesCache, {
                    ...existingNode,
                    observations: Array.from(new Set([...(existingNode.observations || []), ...newObsToAdd]))
                });
            }
        }
    } else {
        entitiesToCreateBatch.push({ name: entityName, entityType: item.type, observations: currentObservations });
        createdOrExistingNodeNamesByCanonicalAbsPath[canonicalItemAbsPathKey] = entityName;
        absolutePathToRelativeNameMap[canonicalItemAbsPathKey] = entityName;
        upsertCacheNode(existingNodesCache, {
            node_id: `pending:${entityName}`,
            name: entityName,
            entityType: item.type,
            observations: currentObservations
        });

        if (item.language === 'typescript' && item.path.endsWith('.ts')) {
            const jsPathKey = createCanonicalAbsPathKey(item.path.slice(0, -3) + '.js');
            absolutePathToRelativeNameMap[jsPathKey] = entityName;
        }
    }

    // Create 'contains_item' relation: ParentDir -> CurrentItem
    const parentDirAbsPath = path.dirname(item.path); // Absolute path of parent
    const canonicalParentDirAbsPathKey = createCanonicalAbsPathKey(parentDirAbsPath);

    // Ensure parent is within effective root and not the item itself
    if (canonicalParentDirAbsPathKey !== canonicalItemAbsPathKey && canonicalParentDirAbsPathKey.startsWith(canonicalEffectiveRootPath)) {
        let parentDirNodeName = createdOrExistingNodeNamesByCanonicalAbsPath[canonicalParentDirAbsPathKey];

        if (!parentDirNodeName) {
            // Calculate relative path for the parent directory from the resolvedProjectRootPath
            let relativeParentPath = path.relative(resolvedProjectRootPath, parentDirAbsPath).replace(/\\/g, '/');
            parentDirNodeName = (relativeParentPath === "" || relativeParentPath === ".") ? "." : relativeParentPath;

            // Check if this parent is already in the batch or the maps
            if (!createdOrExistingNodeNamesByCanonicalAbsPath[canonicalParentDirAbsPathKey] &&
                !entitiesToCreateBatch.find(e => e.name === parentDirNodeName && e.entityType === 'directory')) {
                console.warn(`[ingest_codebase_structure] Parent directory node for '${parentDirNodeName}' (from path '${parentDirAbsPath}') not yet processed. Creating it.`);
                const parentStats = await fs.stat(parentDirAbsPath).catch(() => null);
                const parentObservations = parentStats ? [
                    `absolute_path: ${canonicalParentDirAbsPathKey}`,
                    `type: directory`,
                    `size_bytes: ${parentStats.size.toString()}`,
                    `created_at: ${parentStats.birthtime.toISOString()}`,
                    `modified_at: ${parentStats.mtime.toISOString()}`,
                ] : [`absolute_path: ${canonicalParentDirAbsPathKey}`, `type: directory`];

                entitiesToCreateBatch.push({ name: parentDirNodeName, entityType: 'directory', observations: parentObservations });

                // Immediately update maps for subsequent lookups within this run
                createdOrExistingNodeNamesByCanonicalAbsPath[canonicalParentDirAbsPathKey] = parentDirNodeName;
                absolutePathToRelativeNameMap[canonicalParentDirAbsPathKey] = parentDirNodeName;
                upsertCacheNode(existingNodesCache, {
                    node_id: `pending:${parentDirNodeName}`,
                    name: parentDirNodeName,
                    entityType: 'directory',
                    observations: parentObservations
                });
            } else if (!createdOrExistingNodeNamesByCanonicalAbsPath[canonicalParentDirAbsPathKey] &&
                entitiesToCreateBatch.find(e => e.name === parentDirNodeName && e.entityType === 'directory')) {
                // It's already in the batch to be created, ensure maps are updated if they weren't already
                createdOrExistingNodeNamesByCanonicalAbsPath[canonicalParentDirAbsPathKey] = parentDirNodeName;
                absolutePathToRelativeNameMap[canonicalParentDirAbsPathKey] = parentDirNodeName;
            }
        }

        // `entityName` is the relative path of the current item
        // Use JSON stringify for relation keys to handle special characters in names
        const relationKeyObject = { from: parentDirNodeName, to: entityName, type: 'contains_item' };
        const relationString = JSON.stringify(relationKeyObject);

        if (!relationsToCreateSet.has(relationString)) {
            relationsToCreateSet.add(relationString);
        }
    }
}


async function processFileImports(
    item: ScannedItem,
    agent_id: string,
    resolvedProjectRootPath: string,
    canonicalEffectiveRootPath: string,
    createdOrExistingNodeNamesByCanonicalAbsPath: { [canonicalAbsPathKey: string]: string },
    absolutePathToRelativeNameMap: { [canonicalAbsPathKey: string]: string },
    relationsToCreateSet: Set<string>,
    moduleNamesToProcessOrCreate: Set<string>,
    moduleEntitiesToCreateBatch: Array<{ name: string; entityType: string; observations: string[] }>,
    existingNodesCache: NodeCache,
    memoryManager: MemoryManager,
    codebaseIntrospectionService: CodebaseIntrospectionService
) {
    const canonicalItemAbsPathKey = createCanonicalAbsPathKey(item.path);
    const fileNodeName = createdOrExistingNodeNamesByCanonicalAbsPath[canonicalItemAbsPathKey]; // Use map for consistency

    if (!fileNodeName) {
        console.warn(`[ingest_codebase_structure] Could not find KG node name for file path: ${item.path} (key: ${canonicalItemAbsPathKey}) during import parsing. This might happen if the file itself was not processed into the map correctly.`);
        return;
    }

    const extractedImports: ExtractedImport[] = await codebaseIntrospectionService.parseFileForImports(agent_id, item.path, item.language);

    for (const imp of extractedImports) {
        let toNodeName = imp.targetPath;
        let toNodeType = imp.type;

        if (imp.type === 'file') {
            let resolvedAbsoluteImportPath = path.isAbsolute(imp.targetPath)
                ? imp.targetPath
                : path.resolve(path.dirname(item.path), imp.targetPath);
            resolvedAbsoluteImportPath = resolvedAbsoluteImportPath.replace(/\\/g, '/');

            let actualFilePathOnDisk = await findActualFilePath(resolvedAbsoluteImportPath);
            let canonicalActualFilePathKey = actualFilePathOnDisk ? createCanonicalAbsPathKey(actualFilePathOnDisk) : null;

            if (!actualFilePathOnDisk && resolvedAbsoluteImportPath.endsWith('.js')) {
                const tsEquivalentBasePath = resolvedAbsoluteImportPath.slice(0, -3);
                const foundTsFile = await findActualFilePath(tsEquivalentBasePath);
                if (foundTsFile) {
                    actualFilePathOnDisk = foundTsFile;
                    canonicalActualFilePathKey = createCanonicalAbsPathKey(actualFilePathOnDisk);
                }
            }

            if (canonicalActualFilePathKey && absolutePathToRelativeNameMap[canonicalActualFilePathKey]) {
                toNodeName = absolutePathToRelativeNameMap[canonicalActualFilePathKey];
            } else if (actualFilePathOnDisk && canonicalActualFilePathKey && canonicalActualFilePathKey.startsWith(canonicalEffectiveRootPath)) {
                const relativeImportPath = path.relative(resolvedProjectRootPath, actualFilePathOnDisk).replace(/\\/g, '/');
                toNodeName = (relativeImportPath === "" || relativeImportPath === ".") ? "." : relativeImportPath;

                if (canonicalActualFilePathKey && !absolutePathToRelativeNameMap[canonicalActualFilePathKey]) {
                    // console.warn(`[ingest_codebase_structure] Import target ${actualFilePathOnDisk} resolved to relative path '${toNodeName}', but was not in pre-scan maps. Using relative path as node name.`);
                }
            } else {
                console.warn(`[ingest_codebase_structure] Import target ${imp.targetPath} from ${fileNodeName} (resolved abs: ${resolvedAbsoluteImportPath}, found on disk: ${actualFilePathOnDisk || 'N/A'}) is outside project or not found in scan map. Treating as external module: ${imp.targetPath}`);
                toNodeName = imp.targetPath;
                toNodeType = 'module';
            }
        }

        if (toNodeType === 'external_library' || toNodeType === 'module') {
            if (!moduleNamesToProcessOrCreate.has(toNodeName)) {
                moduleNamesToProcessOrCreate.add(toNodeName);
                let existingModuleNode = getCachedNode(existingNodesCache, toNodeName, 'module');

                if (!existingModuleNode) {
                    try {
                        const fetchedNodes = await memoryManager.knowledgeGraphManager.openNodes(agent_id, [toNodeName]);
                        for (const fetched of fetchedNodes) {
                            upsertCacheNode(existingNodesCache, fetched);
                        }
                        existingModuleNode = fetchedNodes.find((n: any) => n.name === toNodeName && n.entityType === 'module');
                    } catch (error) {
                        console.warn(`[processFileImports] Failed to preload module node ${toNodeName}`, error);
                    }
                }

                if (!existingModuleNode) {
                    moduleEntitiesToCreateBatch.push({ name: toNodeName, entityType: 'module', observations: [`type: ${toNodeType}`] });
                    upsertCacheNode(existingNodesCache, {
                        node_id: `pending:${toNodeName}`,
                        name: toNodeName,
                        entityType: 'module',
                        observations: [`type: ${toNodeType}`]
                    });
                }
            }
        }

        const relationKeyObjectImp = { from: fileNodeName, to: toNodeName, type: imp.type === 'file' ? 'imports_file' : 'imports_module' };
        const relationStringImp = JSON.stringify(relationKeyObjectImp);

        if (!relationsToCreateSet.has(relationStringImp)) {
            relationsToCreateSet.add(relationStringImp);
        }
    }
}

// ============================================================================
// Batch Processors and Handlers
// ============================================================================

async function _ingestFileEntitiesBatch(
    args: { agent_id: string; paths: string | string[]; project_root_path?: string; language?: string },
    memoryManager: MemoryManager,
    introspectionService: CodebaseIntrospectionService,
    existingNodesCache?: NodeCache
): Promise<{ content: { type: 'text'; text: string }[] }> {
    const { agent_id, paths, project_root_path: project_root_path_arg, language: lang_arg } = args;
    const filesToProcess = Array.isArray(paths) ? paths : [paths];

    if (filesToProcess.length === 0) {
        return {
            content: [{
                type: 'text',
                text: formatSimpleMessage(`No files provided for code entity ingestion.`, "Code Entity Ingestion Report")
            }]
        };
    }

    interface FileIngestInfo {
        originalPath: string;
        absolutePath: string;
        effectiveRootPath: string;
        relativeName: string;
    }

    const fileInfos: FileIngestInfo[] = [];
    const nodeNamesToPreload = new Set<string>();

    for (const filePath of filesToProcess) {
        try {
            const effectiveRootPath = path.resolve(project_root_path_arg || path.dirname(filePath));
            const absoluteFilePath = path.resolve(filePath);
            const canonicalFilePath = createCanonicalAbsPathKey(absoluteFilePath);

            if (!canonicalFilePath.startsWith(createCanonicalAbsPathKey(effectiveRootPath))) {
                console.warn(`Skipping file '${absoluteFilePath}' as it is outside the project root '${effectiveRootPath}'.`);
                continue;
            }

            const relativeName = path.relative(effectiveRootPath, absoluteFilePath).replace(/\\/g, '/');
            fileInfos.push({ originalPath: filePath, absolutePath: absoluteFilePath, effectiveRootPath, relativeName });
            nodeNamesToPreload.add(relativeName);
        } catch (error) {
            console.error(`Failed to prepare ingestion for file ${filePath}:`, error);
        }
    }

    if (fileInfos.length === 0) {
        return {
            content: [{
                type: 'text',
                text: formatSimpleMessage(`No eligible files found for code entity ingestion.`, "Code Entity Ingestion Report")
            }]
        };
    }

    if (!existingNodesCache) {
        existingNodesCache = await preloadExistingNodes(agent_id, Array.from(nodeNamesToPreload), memoryManager);
    } else {
        const missingNames = Array.from(nodeNamesToPreload).filter(name => !existingNodesCache!.has(name));
        if (missingNames.length > 0) {
            const supplementalCache = await preloadExistingNodes(agent_id, missingNames, memoryManager);
            for (const [name, nodes] of supplementalCache.entries()) {
                existingNodesCache.set(name, nodes);
            }
        }
    }

    let entitiesCreatedCount = 0;
    let entitiesUpdatedCount = 0;
    let relationsCreatedCount = 0;
    let relationsSkippedCount = 0;
    const filesProcessed: string[] = [];
    let filesSkippedDueToHash = 0;

    const allEntitiesToCreateBatch: Array<{ name: string; entityType: string; observations: string[] }> = [];
    const allObservationsToUpdateBatch: Array<{ entityName: string; contents: string[] }> = [];
    const allRelationsToCreateSet = new Set<string>();

    const ingestConcurrency = Math.max(1, Math.min(6, os.cpus().length - 1 || 1));

    await runWithConcurrency(fileInfos, ingestConcurrency, async info => {
        try {
            const canonicalAbsPath = createCanonicalAbsPathKey(info.absolutePath);
            const fileHash = await computeFileContentHash(info.absolutePath);
            const hashObservation = `content_hash: ${fileHash}`;

            let fileNode = getCachedNode(existingNodesCache!, info.relativeName, 'file');
            const currentObservations = [
                `absolute_path: ${canonicalAbsPath}`,
                `type: file`,
                hashObservation
            ];

            const alreadyIndexed = Boolean(fileNode?.observations?.includes(hashObservation));

            if (!fileNode) {
                const placeholderNode: GraphTraversalNode = {
                    node_id: `pending:${info.relativeName}`,
                    name: info.relativeName,
                    entityType: 'file',
                    observations: currentObservations
                };
                allEntitiesToCreateBatch.push({ name: info.relativeName, entityType: 'file', observations: currentObservations });
                upsertCacheNode(existingNodesCache!, placeholderNode);
                fileNode = placeholderNode;
            } else if (haveObservationsChanged(fileNode.observations, currentObservations)) {
                const newObs = currentObservations.filter(obs => !(fileNode!.observations || []).includes(obs));
                if (newObs.length > 0) {
                    allObservationsToUpdateBatch.push({ entityName: fileNode.name, contents: newObs });
                    fileNode = {
                        ...fileNode,
                        observations: Array.from(new Set([...(fileNode.observations || []), ...newObs]))
                    };
                    upsertCacheNode(existingNodesCache!, fileNode);
                }
            }

            if (alreadyIndexed) {
                filesSkippedDueToHash += 1;
                return;
            }

            const langForParsing = lang_arg || await introspectionService.detectLanguage(agent_id, info.absolutePath, path.basename(info.absolutePath));
            if (langForParsing) {
                const languageObservation = `language: ${langForParsing}`;
                if (!fileNode?.observations?.includes(languageObservation)) {
                    allObservationsToUpdateBatch.push({ entityName: fileNode!.name, contents: [languageObservation] });
                    upsertCacheNode(existingNodesCache!, {
                        ...(fileNode || {
                            node_id: `pending:${info.relativeName}`,
                            name: info.relativeName,
                            entityType: 'file',
                            observations: [] as string[]
                        }),
                        observations: Array.from(new Set([...(fileNode?.observations || []), languageObservation]))
                    });
                }
            }

            const extractedEntities: ExtractedCodeEntity[] = await introspectionService.parseFileForCodeEntities(agent_id, info.absolutePath, langForParsing);

            if (extractedEntities.length > 0) {
                for (const entity of extractedEntities) {
                    await processExtractedEntity(
                        entity,
                        info.relativeName,
                        existingNodesCache!,
                        allEntitiesToCreateBatch,
                        allObservationsToUpdateBatch,
                        allRelationsToCreateSet
                    );
                }
            }

            filesProcessed.push(info.originalPath);
        } catch (error: any) {
            console.error(`Error during code entity ingestion for file ${info.originalPath}:`, error.message || error);
        }
    });

    if (allEntitiesToCreateBatch.length > 0) {
        const creationResult = await memoryManager.knowledgeGraphManager.createEntities(agent_id, allEntitiesToCreateBatch);
        entitiesCreatedCount += countSuccessfulOperations(creationResult);
    }

    if (allObservationsToUpdateBatch.length > 0) {
        const updateResult = await memoryManager.knowledgeGraphManager.addObservations(agent_id, allObservationsToUpdateBatch);
        entitiesUpdatedCount += countSuccessfulOperations(updateResult);
    }

    const finalRelationsToCreate = [] as Array<{ from: string; to: string; relationType: string }>;
    for (const relStr of allRelationsToCreateSet) {
        const relObj = JSON.parse(relStr) as { from: string; to: string; type: string };
        if (!(await memoryManager.knowledgeGraphManager.getExistingRelation(agent_id, relObj.from, relObj.to, relObj.type))) {
            finalRelationsToCreate.push({ from: relObj.from, to: relObj.to, relationType: relObj.type });
        } else {
            relationsSkippedCount++;
        }
    }

    if (finalRelationsToCreate.length > 0) {
        const relationResult = await memoryManager.knowledgeGraphManager.createRelations(agent_id, finalRelationsToCreate);
        relationsCreatedCount += countSuccessfulOperations(relationResult);
    }

    const totalFiles = fileInfos.length;
    const processedCount = filesProcessed.length;
    const skippedMessage = filesSkippedDueToHash > 0 ? `\n- Files Skipped (Unchanged Hash): ${filesSkippedDueToHash}` : '';

    return {
        content: [{
            type: 'text',
            text: formatSimpleMessage(
                `Code entity ingestion for ${processedCount} of ${totalFiles} file(s) complete.\n- Code Entities Newly Created: ${entitiesCreatedCount}\n- Code Entities Updated (Observations): ${entitiesUpdatedCount}\n- Relations Created: ${relationsCreatedCount}\n- Relations Skipped (Duplicates): ${relationsSkippedCount}${skippedMessage}`,
                "Code Entity Ingestion Report"
            )
        }]
    };
}


export function getIngestionHandlers(memoryManager: MemoryManager, codebaseIntrospectionService: CodebaseIntrospectionService) {
    return {
        'ingest_codebase_structure': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for ingest_codebase_structure.");
            }

            const validationResult = validate('ingestCodebaseStructure', args);
            if (!validationResult.valid) {
                throw new McpError(ErrorCode.InvalidParams, `Validation failed for ingest_codebase_structure: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
            }

            const { directory_path, project_root_path, parse_imports, perform_deep_entity_ingestion } = args;

            try {
                // Resolve paths once and use consistently
                const resolvedProjectRootPath = path.resolve(project_root_path || directory_path);
                const resolvedAbsoluteDirectoryPath = path.resolve(directory_path);

                // Create canonical versions for comparison and map keys
                const canonicalEffectiveRootPath = createCanonicalAbsPathKey(resolvedProjectRootPath);
                const canonicalAbsoluteDirectoryPath = createCanonicalAbsPathKey(resolvedAbsoluteDirectoryPath);

                if (!canonicalAbsoluteDirectoryPath.startsWith(canonicalEffectiveRootPath)) {
                    throw new McpError(ErrorCode.InvalidParams, `Directory path (${resolvedAbsoluteDirectoryPath}) must be within the project root path (${resolvedProjectRootPath}).`);
                }

                // Initialize counters and collections
                let nodesCreatedCount = 0;
                let nodesUpdatedCount = 0;
                let relationsCreatedCount = 0;
                const filesForDeepScan: string[] = [];

                // Maps to store node names by their canonical absolute paths for efficient lookup
                const createdOrExistingNodeNamesByCanonicalAbsPath: { [canonicalAbsPathKey: string]: string } = {};

                // Maps canonical absolute paths to their *relative* KG node names
                const absolutePathToRelativeNameMap: { [canonicalAbsPathKey: string]: string } = {};

                const entitiesToCreateBatch: Array<{ name: string; entityType: string; observations: string[] }> = [];
                const observationsToUpdateBatch: Array<{ entityName: string; contents: string[] }> = [];

                // Store relation objects as JSON strings to ensure uniqueness correctly handles complex node names
                const relationsToCreateSet = new Set<string>();

                const moduleEntitiesToCreateBatch: Array<{ name: string; entityType: string; observations: string[] }> = [];
                const moduleNamesToProcessOrCreate = new Set<string>();

                console.log(`[ingest_codebase_structure] Scanning directory: ${resolvedAbsoluteDirectoryPath} relative to root: ${resolvedProjectRootPath}`);

                // Pass resolvedProjectRootPath to scanDirectoryRecursive so it calculates relative paths correctly from the true project root.
                const scannedItems: ScannedItem[] = await codebaseIntrospectionService.scanDirectoryRecursive(
                    agent_id,
                    resolvedAbsoluteDirectoryPath,
                    resolvedProjectRootPath
                );

                console.log(`[ingest_codebase_structure] Scanned ${scannedItems.length} items.`);

                const nodeNamesToPreload = new Set<string>();
                nodeNamesToPreload.add('.');
                for (const item of scannedItems) {
                    const entityName = item.name === '' ? '.' : item.name;
                    nodeNamesToPreload.add(entityName);
                }

                const existingNodesCache = await preloadExistingNodes(agent_id, Array.from(nodeNamesToPreload), memoryManager);

                // Handle the root directory itself if it's part of the scan scope
                if (resolvedAbsoluteDirectoryPath === resolvedProjectRootPath) {
                    await processRootDirectory(
                        resolvedProjectRootPath,
                        existingNodesCache,
                        createdOrExistingNodeNamesByCanonicalAbsPath,
                        absolutePathToRelativeNameMap,
                        entitiesToCreateBatch,
                        observationsToUpdateBatch
                    );
                }

                // Process scanned files and directories
                for (const item of scannedItems) {
                    await processScannedItem(
                        item,
                        resolvedProjectRootPath,
                        canonicalEffectiveRootPath,
                        existingNodesCache,
                        createdOrExistingNodeNamesByCanonicalAbsPath,
                        absolutePathToRelativeNameMap,
                        entitiesToCreateBatch,
                        observationsToUpdateBatch,
                        relationsToCreateSet
                    );

                    if (item.type === 'file' && item.language) {
                        filesForDeepScan.push(item.path);
                    }
                }

                // Create entities and update observations
                if (entitiesToCreateBatch.length > 0) {
                    console.log(`[ingest_codebase_structure] Batch creating ${entitiesToCreateBatch.length} file/directory nodes.`);
                    const creationResult = await memoryManager.knowledgeGraphManager.createEntities(agent_id, entitiesToCreateBatch);
                    nodesCreatedCount += countSuccessfulOperations(creationResult);
                }

                if (observationsToUpdateBatch.length > 0) {
                    console.log(`[ingest_codebase_structure] Batch updating observations for ${observationsToUpdateBatch.length} nodes.`);
                    const updateResult = await memoryManager.knowledgeGraphManager.addObservations(agent_id, observationsToUpdateBatch);
                    nodesUpdatedCount += countSuccessfulOperations(updateResult);
                }

                // Parse imports if requested
                if (parse_imports) {
                    console.log(`[ingest_codebase_structure] Parsing imports...`);
                    for (const item of scannedItems) {
                        if (item.type === 'file' && item.language && ['typescript', 'javascript', 'python', 'php'].includes(item.language)) {
                            await processFileImports(
                                item,
                                agent_id,
                                resolvedProjectRootPath,
                                canonicalEffectiveRootPath,
                                createdOrExistingNodeNamesByCanonicalAbsPath,
                                absolutePathToRelativeNameMap,
                                relationsToCreateSet,
                                moduleNamesToProcessOrCreate,
                                moduleEntitiesToCreateBatch,
                                existingNodesCache,
                                memoryManager,
                                codebaseIntrospectionService
                            );
                        }
                    }

                    // Create module entities
                    if (moduleEntitiesToCreateBatch.length > 0) {
                        console.log(`[ingest_codebase_structure] Batch creating ${moduleEntitiesToCreateBatch.length} module nodes.`);
                        const moduleCreationResult = await memoryManager.knowledgeGraphManager.createEntities(agent_id, moduleEntitiesToCreateBatch);
                        nodesCreatedCount += countSuccessfulOperations(moduleCreationResult);
                    }
                }

                // Create relations
                const finalRelationsToCreate: Array<{ from: string; to: string; relationType: string }> = [];
                let relationsSkippedCount = 0;

                for (const relStr of relationsToCreateSet) {
                    const relObj = JSON.parse(relStr) as { from: string; to: string; type: string };
                    const existingRelation = await memoryManager.knowledgeGraphManager.getExistingRelation(agent_id, relObj.from, relObj.to, relObj.type);
                    if (existingRelation) {
                        relationsSkippedCount++;
                    } else {
                        finalRelationsToCreate.push({ from: relObj.from, to: relObj.to, relationType: relObj.type });
                    }
                }

                if (finalRelationsToCreate.length > 0) {
                    console.log(`[ingest_codebase_structure] Batch creating ${finalRelationsToCreate.length} new relations.`);
                    const relationResult = await memoryManager.knowledgeGraphManager.createRelations(agent_id, finalRelationsToCreate);
                    relationsCreatedCount += countSuccessfulOperations(relationResult);
                }

                if (relationsSkippedCount > 0) {
                    console.log(`[ingest_codebase_structure] Skipped ${relationsSkippedCount} existing relations as duplicates.`);
                }

                let structuralReport = `Codebase structure ingestion for directory "${directory_path}" complete.\n- Nodes Newly Created: ${nodesCreatedCount}\n- Nodes Updated (Observations): ${nodesUpdatedCount}\n- Relations Created: ${relationsCreatedCount}`;
                let deepScanReport = "";

                // --- DEEP SCAN EXECUTION ---
                if (perform_deep_entity_ingestion && filesForDeepScan.length > 0) {
                    console.log(`[ingest_codebase_structure] Performing deep entity scan on ${filesForDeepScan.length} files.`);
                    const deepScanResult = await _ingestFileEntitiesBatch({
                        agent_id,
                        project_root_path: resolvedProjectRootPath,
                        paths: filesForDeepScan
                    }, memoryManager, codebaseIntrospectionService, existingNodesCache);

                    // Extract the text from the result to append to our report
                    const deepScanMessage = deepScanResult.content[0].text;
                    // Remove the title from the deep scan report to avoid redundancy
                    deepScanReport = deepScanMessage.substring(deepScanMessage.indexOf('\n') + 1).trim();
                }

                const finalReport = deepScanReport
                    ? `${structuralReport}\n\n**Deep Scan Results:**\n${deepScanReport}`
                    : structuralReport;

                return {
                    content: [{
                        type: 'text',
                        text: formatSimpleMessage(finalReport, "Full Codebase Ingestion Report")
                    }]
                };
            } catch (error: any) {
                console.error(`[ingest_codebase_structure] Error during codebase structure ingestion for agent ${agent_id}, path ${directory_path}:`, error);
                throw new McpError(ErrorCode.InternalError, `Codebase ingestion failed: ${error.message}`);
            }
        },

        'ingest_file_code_entities': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for ingest_file_code_entities.");
            }

            const validationResult = validate('ingestFileCodeEntities', args);
            if (!validationResult.valid) {
                throw new McpError(ErrorCode.InvalidParams, `Validation failed for ingest_file_code_entities: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
            }

            // This handler now acts as a simple wrapper around the batch processor.
            return _ingestFileEntitiesBatch(
                {
                    agent_id,
                    paths: args.paths,
                    project_root_path: args.project_root_path,
                    language: args.language
                },
                memoryManager,
                codebaseIntrospectionService,
                undefined
            );
        },
    };
}