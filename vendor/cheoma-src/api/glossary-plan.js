// Public, renderer-free focus glossary anchors (#216).
// Internal modules import layout/glossary-plan.js directly; app/tools use this façade.
export {
  GLOSSARY_DISCLAIMER_KO,
  GLOSSARY_LABEL_IDS,
  GLOSSARY_SCHEMA_VERSION,
  glossaryHasBrackets,
  glossaryLocalToWorld,
  glossaryRoofCover,
  isGlossarySubject,
  planGlossaryAnchors,
} from '../layout/glossary-plan.js';
