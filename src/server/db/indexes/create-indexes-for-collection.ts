import { Collection, IndexSpecification, MongoError } from 'mongodb';
import chalk from 'chalk';
import { FieldOrSpec, MongoIndexSpec } from './configure-indexes';
import { MongoErrorCode } from './mongo-error-code';
import { Logger } from '../../../commons/logger/logger';

const logger = new Logger('metroline.server:db.indexes.configure');

function findIndexWithSameKey(existingIndexes: IndexSpecification[], fieldOrSpec: FieldOrSpec) {
  const fields = typeof fieldOrSpec === 'string' ? [fieldOrSpec] : Object.keys(fieldOrSpec);
  // two indexes have the same key when they declare exactly the same fields
  return existingIndexes.find(index => {
    // text indexes contain fields in index.weights, whereas normal indexes have it in index.key
    const objectWithFields = index.weights || index.key;
    return fields.every(fieldName => Object.prototype.hasOwnProperty.call(objectWithFields, fieldName))
      && fields.length === Object.keys(objectWithFields).length;
  });
}

function computeIndexName(fieldOrSpec: string | any): string {
  return typeof fieldOrSpec === 'string' ? fieldOrSpec : Object.keys(fieldOrSpec).join('_');
}

async function createIndexIfNotExists(spec: MongoIndexSpec, collection: Collection) {
  const indexName = spec.options.name;
  const indexNamespace = `${chalk.blue(collection.collectionName)}.${chalk.cyan(indexName)}`;

  const createIndex = () => collection.createIndex(spec.fieldOrSpec, spec.options);

  try {
    await createIndex();
    logger.debug(`Configured index ${indexNamespace}`);
  } catch (e) {
    if (
      e instanceof MongoError
      && (
        e.code === MongoErrorCode.INDEX_OPTIONS_CONFLICT
        || e.code === MongoErrorCode.INDEX_KEY_SPECS_CONFLICT
      )
    ) {
      logger.debug(`Updating index ${indexNamespace}`);

      const existingIndexes: IndexSpecification[] = await collection.listIndexes().toArray();
      const indexWithSameName = existingIndexes.find(value => value.name === spec.options.name);
      if (indexWithSameName) {
        await collection.dropIndex(indexName);
      } else {
        const indexWithSameKey = findIndexWithSameKey(existingIndexes, spec.fieldOrSpec);
        await collection.dropIndex(indexWithSameKey.name);
      }

      logger.debug(`Updated index ${indexNamespace}`);

      await createIndex();
    } else {
      throw e;
    }
  }
}

export async function configureIndexesForCollection(collection: Collection, specs: MongoIndexSpec[]) {
  // ensure indexes have a name

  specs
    .filter(spec => !spec.options?.name)
    .forEach(spec => {
      spec.options = {
        ...spec.options,
        name: computeIndexName(spec.fieldOrSpec),
      };
    });

  // create indexes that don't already exist, or modify them

  await Promise.all(
    specs.map(spec => createIndexIfNotExists(spec, collection)),
  );

  // drop indexes that do not exist anymore

  const existingIndexes: IndexSpecification[] = await collection.listIndexes().toArray();
  const indexesToDrop = existingIndexes
    .filter(index => index.name !== '_id_')
    .filter(index => specs.every(spec => spec.options.name !== index.name));

  await Promise.all(
    indexesToDrop.map(({ name }) => {
      logger.info(`Dropping index ${chalk.bold(name)}`);
      return collection.dropIndex(name);
    }),
  );
}
