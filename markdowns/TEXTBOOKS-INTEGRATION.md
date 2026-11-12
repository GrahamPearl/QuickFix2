# Textbooks page: integration steps
New files: textbooks.html, js/textbooks-form.js, js/textbooks-service.js, js/textbooks-app.js.

## 1. json/usertypes.json (permissions)
- viewTextbooks, captureTextbooks: true -> admin, staff-head, staff-gc, staff
- manageTextbooks: true -> admin, staff-head, staff-gc

## 2. js/pages.js (inside PAGES)
{ group: "Resources", label: "Textbooks", href: "textbooks.html", perm: "viewTextbooks", desc: "Book register, issue and return by barcode, class-list import and export." },

## 3. firebase.rules
function canViewTextbooks()    { return typeIn(['admin','staff-head','staff-gc','staff']); }
function canCaptureTextbooks() { return typeIn(['admin','staff-head','staff-gc','staff']); }
function canManageTextbooks()  { return typeIn(['admin','staff-head','staff-gc']); }

match /textbook-titles/{id} {
  allow read: if canViewTextbooks();
  allow create: if canCaptureTextbooks();
  allow update, delete: if canManageTextbooks();
}
match /textbooks/{code} {
  allow read: if canViewTextbooks();
  allow create: if canCaptureTextbooks();
  allow update: if canManageTextbooks()
    || (canCaptureTextbooks() && request.resource.data.diff(resource.data).affectedKeys().hasOnly(
        ['status','condition','currentAdminNo','issuedName','issuedGrade','issuedClass','issuedOn','issuedBy','updatedBy','updatedAt']));
  allow delete: if isAdminOrHead();
}
match /textbook-loans/{id} {
  allow create: if canCaptureTextbooks();
  allow read: if canManageTextbooks();
  allow update, delete: if false;
}

## 4. Indexes
None. Every query is a single-field equality (or one orderBy) with a limit.
