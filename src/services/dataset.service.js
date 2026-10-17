import { createDataset, createDatasetVersion, getDatasetById, listDatasets } from '../repositories/datasets.repository.js';
import { HttpError } from '../middleware/error-handler.js';
import { calibrateGoldenExamples } from './evaluation-quality.service.js';

export const datasetService = {
  create(data, ownerId) {
    return createDataset(data, ownerId);
  },
  async createVersion(id, data, ownerId) {
    const dataset = await createDatasetVersion(id, data, ownerId);
    if (!dataset) throw new HttpError(404, 'Dataset not found');
    return dataset;
  },
  list(ownerId) {
    return listDatasets(ownerId);
  },
  async getById(id, ownerId) {
    const dataset = await getDatasetById(id, ownerId);
    if (!dataset) throw new HttpError(404, 'Dataset not found');
    return dataset;
  },
  async calibrate(id, ownerId, versionId = null) {
    const dataset = await getDatasetById(id, ownerId, versionId);
    if (!dataset) throw new HttpError(404, 'Dataset not found');
    return calibrateGoldenExamples({ dataset, testCases: dataset.test_cases ?? [] });
  }
};
