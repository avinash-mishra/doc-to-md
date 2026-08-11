/* pdf.js worker entry point.
   A module worker gets its own global scope, so the polyfills the main
   thread installs do not reach it — they have to be imported here too,
   ahead of the real worker. pdf.js is pointed at this file instead of
   vendor/pdfjs/. */
import "./compat-polyfills.mjs";
import "./vendor/pdfjs/pdf.worker.min.mjs";
