/**
 * OGraf Loader — OGraf manifest ve grafik paketlerini yükler
 *
 * OGraf spec'ine göre bir grafik paketi:
 *   - graphic.ograf.json  → manifest (schema, metadata)
 *   - graphic.mjs         → Web Component (play, stop, update, next)
 */

import * as fs from 'fs';
import * as path from 'path';

/** OGraf Manifest — graphic.ograf.json */
export interface OGrafManifest {
  $schema?: string;
  id: string;
  name: string;
  main: string;
  description?: string;
  supportsRealTime: boolean;
  supportsNonRealTime: boolean;
  stepCount: number;
  schema: {
    type: 'object';
    properties: Record<string, OGrafSchemaProperty>;
  };
  customActions?: Array<{
    id: string;
    name: string;
    description?: string;
    schema?: any;
  }>;
}

export interface OGrafSchemaProperty {
  type: string;
  default?: any;
  enum?: any[];
  description?: string;
}

/** Loaded OGraf graphic package */
export interface OGrafPackage {
  manifest: OGrafManifest;
  /** Absolute path to the package directory */
  packageDir: string;
  /** Absolute path to the main module file */
  mainFile: string;
  /** Default data values from schema */
  defaultData: Record<string, any>;
}

/**
 * Load an OGraf package from a directory
 */
export function loadOGrafPackage(packageDir: string): OGrafPackage {
  const manifestPath = findManifest(packageDir);
  if (!manifestPath) {
    throw new Error(`No .ograf.json manifest found in ${packageDir}`);
  }

  const manifestRaw = fs.readFileSync(manifestPath, 'utf-8');
  const manifest: OGrafManifest = JSON.parse(manifestRaw);

  // Validate required fields
  if (!manifest.id) throw new Error('OGraf manifest missing "id"');
  if (!manifest.name) throw new Error('OGraf manifest missing "name"');
  if (!manifest.main) throw new Error('OGraf manifest missing "main"');

  const mainFile = path.resolve(packageDir, manifest.main);
  if (!fs.existsSync(mainFile)) {
    throw new Error(`Main module not found: ${mainFile}`);
  }

  // Extract default values from schema
  const defaultData: Record<string, any> = {};
  if (manifest.schema?.properties) {
    for (const [key, prop] of Object.entries(manifest.schema.properties)) {
      if (prop.default !== undefined) {
        defaultData[key] = prop.default;
      }
    }
  }

  return {
    manifest,
    packageDir: path.resolve(packageDir),
    mainFile,
    defaultData,
  };
}

/**
 * Find the .ograf.json manifest in a directory
 */
function findManifest(dir: string): string | null {
  const files = fs.readdirSync(dir);
  const manifestFile = files.find((f) => f.endsWith('.ograf.json'));
  if (manifestFile) {
    return path.join(dir, manifestFile);
  }
  return null;
}

/**
 * Generate the HTML host page that loads an OGraf web component
 * OGraf web component'ini yükleyen HTML sayfasını oluşturur
 */
export function generateHostPage(pkg: OGrafPackage, data?: Record<string, any>): string {
  const graphicData = { ...pkg.defaultData, ...data };
  const moduleUrl = `file:///${pkg.mainFile.replace(/\\/g, '/')}`;
  const packageUrl = `file:///${pkg.packageDir.replace(/\\/g, '/')}/`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: transparent;
    }
    ${pkg.manifest.id} {
      display: block;
      width: 100%;
      height: 100%;
    }
  </style>
  <base href="${packageUrl}">
</head>
<body>
  <${pkg.manifest.id}></${pkg.manifest.id}>

  <script type="module">
    import '${moduleUrl}';

    const graphic = document.querySelector('${pkg.manifest.id}');

    // OGraf control API — window'a expose et
    window.ografAPI = {
      graphic: graphic,
      play: () => graphic?.play?.(),
      stop: () => graphic?.stop?.(),
      next: () => graphic?.next?.(),
      update: (data) => graphic?.update?.(data),
      getData: () => (${JSON.stringify(graphicData)}),
    };

    // Hazır olduğunda bildir
    window.postMessage({ type: 'ograf-ready', id: '${pkg.manifest.id}' }, '*');

    // İlk data'yı set et
    if (graphic?.update) {
      graphic.update(${JSON.stringify(graphicData)});
    }
  </script>
</body>
</html>`;
}
