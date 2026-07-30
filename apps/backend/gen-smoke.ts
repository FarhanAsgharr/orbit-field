import { createApp } from './src/app.js';
import { generateOpenApiDocument } from './src/openapi/generate.js';
const doc = generateOpenApiDocument(createApp());
const paths = Object.keys(doc.paths);
console.log('openapi:', doc.openapi);
console.log('paths:', paths.length);
console.log('operations:', paths.reduce((n, p) => n + Object.keys(doc.paths[p]!).length, 0));
console.log('tags:', doc.tags.map((t: any) => t.name).join(', '));
console.log('invitation paths:', paths.filter((p) => p.includes('invitation')).join(' | '));
