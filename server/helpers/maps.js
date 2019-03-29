const Fuse = require('fuse.js');
const { cache } = require('../utils/cache');
const dynamo = require('../utils/dynamoClient');
const { APIError } = require('../utils/errors');
const suggestions = require('../utils/suggestions.json');
const { cacheKeys } = require('../constants.json');

const fuse = new Fuse(suggestions, { keys: ['key'] });
const suggestionsByTitle = suggestions.reduce(
  (obj, sugg) => ({ ...obj, [sugg.title]: sugg }),
  {},
);

// Fuzzy search maps by key name.
async function fuzzySearch(query) {
  // If the query is specified search for that, otherwise return a
  // random document.
  if (query) {
    return fuse.search(query);
  }
  const randIndex = Math.floor(Math.random() * (suggestions.length - 1));
  return [suggestions[randIndex]];
}

// Get a specific map by ID.
async function byID(mapID) {
  // Get Map metadata from DynamoDB.
  const { Item } = await dynamo('get', {
    TableName: 'Maps',
    Key: { mapID: Number(mapID) },
  });

  if (!Item) {
    throw new APIError(404, 'map not found');
  }

  const map = {
    ...Item,
    nodes: {},
    resources: {},
  };

  // Query DynamoDB to get the nodes for the current map.
  const nodesPromise = dynamo('query', {
    TableName: 'Nodes',
    IndexName: 'MapIndex',
    Select: 'ALL_ATTRIBUTES',
    KeyConditionExpression: 'mapID = :value',
    ExpressionAttributeValues: {
      ':value': Number(mapID),
    },
  });

  // Query DynamoDB to get the resources for the current map.
  const resourcesPromise = dynamo('query', {
    TableName: 'Resources',
    IndexName: 'MapIndex',
    Select: 'ALL_ATTRIBUTES',
    KeyConditionExpression: 'mapID = :value',
    ExpressionAttributeValues: {
      ':value': Number(mapID),
    },
  });

  const [nodes, resources] = await Promise.all([
    nodesPromise,
    resourcesPromise,
  ]);

  // Convert the list to a dictionary having parent nodes as keys, and lists
  // of nodes as values. This is used by the render component.
  nodes.Items.forEach(node => {
    if (map.nodes[node.parentID]) {
      // If there's already some nodes with the same parent, append this node
      // to the list.

      map.nodes[node.parentID].push(node);
    } else if (node.parentID === null) {
      // If the parentID is null, it means that this is the root node, and
      // there can be only one root node, so no point in having an array here.

      map.nodes[node.parentID] = node;
    } else {
      // If none of the above cases apply, we create a list and add this node
      // to it.

      map.nodes[node.parentID] = [node];
    }
  });

  // Convert the list to a dictionary having parent nodes as keys, and lists
  // of resources as values. This is used by the render component.
  resources.Items.forEach(resource => {
    // Same logic as above apply, only that we don't have a "root resource".
    // All resources must have a parent node, and no resource has a child.
    if (map.resources[resource.parentID]) {
      map.resources[resource.parentID].push(resource);
    } else {
      map.resources[resource.parentID] = [resource];
    }
  });

  return map;
}

// Get a specific map by title.
async function byTitle(title) {
  const cleanTitle = title
    .replace(/^learn anything - /, '/')
    .replace(/ - /g, '/')
    .replace(/ /g, '-');
  const { id } = suggestionsByTitle[cleanTitle] || {};

  // There can't be more than one result, as the limit for this ES query is 1,
  // and in any case, map titles should be unique.
  if (id === undefined) {
    throw new APIError(404, 'map not found');
  }

  // Now that we have the ID, let's retrieve the whole map.
  const key2 = cacheKeys.maps.byID + id;
  return cache(key2, byID(id));
}

module.exports = {
  fuzzySearch,
  byID,
  byTitle,
};
