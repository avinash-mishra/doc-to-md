/* pdf.js worker entry point.
   A module worker gets its own global scope, so the polyfill the main thread
   installs does not reach it — it has to be imported here too, ahead of the
   real worker. pdf.js is pointed at this file instead of vendor/pdfjs/. */
import "./upsert-polyfill.mjs";
import "./vendor/pdfjs/pdf.worker.min.mjs";
