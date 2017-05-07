const path = require('path');
const zlib = require('zlib');

const fsp = require('fs-extra');
const mkdirp = require('mkdirp');
const mime = require('mime-types');
const recursive = require('recursive-readdir');

function toHexPayload(data) {
  return data
    .toString('hex')
    .match(/.{1,2}/g)
    .map(hex => ` 0x${hex}`)
    .toString()
    .match(/.{1,72}/g)
    .map(line => `${line}\n`)
    .join('   ');
}

function makeChunks(buffer, chunkSize) {
  const result = [];
  const len = buffer.length;
  let i = 0;

  while (i < len) {
    result.push(buffer.slice(i, i += chunkSize));
  }

  return result;
}

function readSource({ sources, indexFile }, filename) {
  return fsp.readFile(filename, { encoding: null })
    .then((fileData) => {
      const zipped = zlib.gzipSync(fileData);
      const relativePath = path.relative(sources, filename);
      const chunks = makeChunks(zipped, 32767);
      let part = 0;

      return Promise.resolve({
        urlPath: relativePath !== indexFile ? relativePath : '',
        contentType: mime.contentType(path.extname(filename)),
        name: `static_${relativePath !== indexFile ? relativePath.toLowerCase().replace(/[^\w+$]/gi, '_') : 'index'}`,
        payloads: chunks.map(chunk =>
          ({ chunkData: toHexPayload(chunk), chunkLength: chunk.length, chunkPart: (part += 1) })),
        length: zipped.length,
      });
    });
}

function writeFile(filename, contents) {
  return new Promise((resolve, reject) => {
    mkdirp(path.dirname(filename), (err) => {
      if (err) {
        reject(err);
      }

      return resolve(fsp.writeFile(filename, contents));
    });
  });
}

function getSourcesFiles({ sources, exclude }) {
  return new Promise((resolve, reject) => {
    recursive(sources, exclude, (err, files) => {
      if (err) {
        return reject(err);
      }

      return resolve(files);
    });
  });
}

function renderAsset({ name, contentType, payloads }) {
  return `void ${name} (Request &req, Response &res) {
${payloads.map(({ chunkData, chunkPart }) => `  P(${name}_${chunkPart}) = {\n   ${chunkData}  };`).join('\n')}

  res.set("Content-Encoding", "gzip");
  res.success("${contentType}");
${payloads.map(({ chunkLength, chunkPart }) => `  res.writeP(${name}_${chunkPart}, ${chunkLength});`).join('\n')}
}`;
}

function renderRouter(sourceOptions) {
  return `

void ServeStatic(WebApp* app) {
${sourceOptions.map(({ urlPath, name }) => `  app->get("${urlPath}", &${name});`).join('\n')}
}`;
}

function generatePayloads({ sketchDir }, sourceOptions) {
  const destination = `${sketchDir}/StaticFiles.h`;
  const payloads = sourceOptions.map(renderAsset).join('\n\n');
  const router = renderRouter(sourceOptions);

  return writeFile(destination, payloads + router);
}

function generateSketch({ createSketch, sketchDir }) {
  if (createSketch === 'no') {
    return Promise.resolve();
  }

  const cleanedSketchDir = sketchDir.replace(/\/$/, '');
  const destination = `${cleanedSketchDir}/${cleanedSketchDir.split('/').pop()}.ino`;
  const libName = createSketch === 'wifi' ? 'WiFi' : 'Ethernet';
  const vars = createSketch === 'wifi' ?
    'char ssid[] = "ssid";\nchar password[] = "pass";' :
    'byte mac[] = { 0xDE, 0xAD, 0xBE, 0xEF, 0xFE, 0xED };';

  const setup = createSketch === 'wifi' ?
    `  WiFi.begin(ssid, password);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println("");
  Serial.println(WiFi.localIP());` :
    `  if (Ethernet.begin(mac)) {
    Serial.println(Ethernet.localIP());
  } else {
    Serial.println("Ethernet failed");
  }`;


  const sketch = `#include <SPI.h>
#include <${libName}.h>
#include <aWOT.h>

#include "StaticFiles.h"

${vars}
${libName}Server server(80);

WebApp app;

void setup() {
  Serial.begin(115200);

${setup}

  server.begin();
  ServeStatic(&app);
}

void loop() {
  ${libName}Client client = server.available();
  if (client) {
    app.process(&client);
  }
}
`;

  return writeFile(destination, sketch);
}

function generateFiles(options) {
  return getSourcesFiles(options)
    .then(filenames => Promise.all(filenames.map(filename => readSource(options, filename))))
    .then(sourceOptions => generatePayloads(options, sourceOptions))
    .then(() => generateSketch(options));
}

module.exports = generateFiles;