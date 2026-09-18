// Lokale HTTPS-testserver. Nodig omdat mobiele browsers geolocatie/kompas
// alleen toestaan over HTTPS (localhost uitgezonderd, maar je telefoon is
// geen localhost t.o.v. deze pc). Certificaat is zelfondertekend: je telefoon
// zal een waarschuwing tonen, die moet je handmatig accepteren ("doorgaan
// naar deze site").
//
// Gebruik: node dev-server.js   -> https://<lan-ip>:8443
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");

const PORT = 8443;
const CERT_DIR = path.join(__dirname, ".certs");
const KEY_PATH = path.join(CERT_DIR, "key.pem");
const CERT_PATH = path.join(CERT_DIR, "cert.pem");

function ensureCert() {
  if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH)) return;
  fs.mkdirSync(CERT_DIR, { recursive: true });
  console.log("Genereer zelfondertekend certificaat met openssl…");
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", KEY_PATH, "-out", CERT_PATH,
      "-days", "825",
      "-subj", "/CN=hemelkijker.local",
    ],
    { stdio: "inherit" }
  );
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function serve(req, res) {
  let filePath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  filePath = path.join(__dirname, decodeURIComponent(filePath));
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

function lanAddresses() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) out.push(net.address);
    }
  }
  return out;
}

ensureCert();

const server = https.createServer(
  { key: fs.readFileSync(KEY_PATH), cert: fs.readFileSync(CERT_PATH) },
  serve
);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\nHemelkijker draait op:`);
  for (const ip of lanAddresses()) console.log(`  https://${ip}:${PORT}`);
  console.log(`  https://localhost:${PORT}`);
  console.log(`\nOpen die eerste URL op je telefoon (zelfde wifi-netwerk).`);
  console.log(`Je krijgt een certificaatwaarschuwing — kies "toch doorgaan".\n`);
});
