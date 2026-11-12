# Behaviour page: integration steps
New files: behaviour.html, js/behaviour-form.js, js/behaviour-service.js, js/behaviour-app.js.

## 1. json/usertypes.json (permissions)
- addBehaviour: true  -> admin, staff-head, staff-gc, staff, slt
- viewBehaviour, manageBehaviour: true -> admin, staff-head, staff-gc
- adminBehaviour: true -> admin, staff-head   (sees "serious" entries)

## 2. js/pages.js (inside PAGES)
{ group: "Classroom", label: "Behaviour", href: "behaviour.html", perm: "addBehaviour", desc: "Record uniform infringements, merits, incidents; detention register." },

## 3. firebase.rules (helpers + match blocks)
function canAddBehaviour()    { return typeIn(['admin','staff-head','staff-gc','staff','slt']); }
function canManageBehaviour() { return typeIn(['admin','staff-head','staff-gc']); }
function isBehaviourAdmin()   { return typeIn(['admin','staff-head']); }

match /behaviour-entries/{id} {
  allow read: if isBehaviourAdmin()
    || (typeIn(['staff-gc']) && resource.data.severity in ['minor','moderate'])
    || (canAddBehaviour() && resource.data.recordedBy == request.auth.uid
        && resource.data.recordedAt > request.time - duration.value(1, 'd'));
  allow create: if canAddBehaviour()
    && request.resource.data.recordedBy == request.auth.uid
    && request.resource.data.recordedByEmail == myEmail()
    && request.resource.data.recordedAt == request.time
    && request.resource.data.status == 'active'
    && request.resource.data.type in ['uniform','merit','demerit','incident']
    && request.resource.data.severity in ['minor','moderate','serious']
    && request.resource.data.adminNo.matches('[0-9]{5,6}')
    && request.resource.data.get('note','').size() <= 300;
  // void only: managers, and gc never on serious entries
  allow update: if canManageBehaviour() && (isBehaviourAdmin() || resource.data.severity != 'serious')
    && resource.data.status == 'active' && request.resource.data.status == 'voided'
    && request.resource.data.diff(resource.data).affectedKeys()
         .hasOnly(['status','voidedBy','voidedByEmail','voidedAt','voidedReason']);
  allow delete: if isBehaviourAdmin();
}
match /detentions/{id} {
  allow read, create, update: if canManageBehaviour();
  allow delete: if isBehaviourAdmin();
}

## 4. Indexes (Firestore asks for them on first use; follow the console link)
behaviour-entries: recordedBy ASC + recordedAt DESC;  severity ASC + occurredOn DESC
