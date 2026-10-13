import { createDataset, getDatasetById, listDatasets } from '../repositories/datasets.repository.js';
import { HttpError } from '../middleware/error-handler.js';

export const datasetService = {
  create(data) {
    return createDataset(data);
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
