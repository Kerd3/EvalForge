import { createDataset, createDatasetVersion, getDatasetById, listDatasets } from '../repositories/datasets.repository.js';
import { HttpError } from '../middleware/error-handler.js';

export const datasetService = {
  create(data) {
    return createDataset(data);
  },
  async createVersion(id, data) {
    const dataset = await createDatasetVersion(id, data);
    if (!dataset) throw new HttpError(404, 'Dataset not found');
    return dataset;
  },
  list() {
    return listDatasets();
  },
  async getById(id) {
    const dataset = await getDatasetById(id);
    if (!dataset) throw new HttpError(404, 'Dataset not found');
    return dataset;
  }
};
