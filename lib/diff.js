import rdf from 'rdf-ext'

async function rdfAssetsDiff (oldAssets, newAssets) {
  const added = rdf.dataset()
  const removed = rdf.dataset()
  for (const { path, dataset } of oldAssets) {
    const newDataset = newAssets.find(x => x.path === path).dataset
    added.addAll(newDataset.difference(dataset))
    removed.addAll(dataset.difference(newDataset))
  }
  return { added, removed }
}

export { rdfAssetsDiff }
