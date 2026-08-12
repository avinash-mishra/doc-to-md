import "./compat-polyfills.mjs";
import * as pdfjsLib from "./vendor/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./pdf-worker-shim.mjs";
window.pdfjsLib = pdfjsLib;
