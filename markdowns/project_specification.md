# Project Specification: Hillcrest High School Student Lookup & Hall Pass System

## 1. Project Overview & Context
* **Institution:** Hillcrest High School (HHS)
* **Project Name:** Student Lookup
* **Primary Goal:** Provide a fast, secure, web-based platform for staff to manage student hall passes, look up student profiles by a 5-digit admin number, enforce venue capacity limits, track active out-of-class duration, and maintain an immutable historical movement ledger.

---

## 2. System Architecture & Tech Stack
* **Frontend:** Vanilla JS (ES Modules), HTML5, CSS3 (Custom utility CSS with flex/grid).
* **Backend Services:** Firebase JS SDK (v9+ modular).
  * **Authentication:** Firebase Auth (Email/Password, OAuth Provider / Microsoft Single Sign-On).
  * **Database:** Cloud Firestore (NoSQL).
* **State Management:** Modular ES import pattern (`auth-service.js`, `movement-service.js`, etc.) maintaining client-side state in memory.

---

## 3. Database Schema Design (Firestore)

### 3.1. Collection: `students`
* **Document ID:** 5-Digit Admin Number (e.g., `"10425"`)
* **Fields:**
  ```typescript
  {
    adminNo: string;              // e.g. "10425"
    fullName: string;             // e.g. "John Doe"
    grade: number;                // e.g. 10
    registrationClass: string;   // e.g. "10A"
    photo: string;                // URL or Base64 avatar string
    isOut: boolean;               // Denormalized state flag
    currentReason: string | null; // e.g. 'toilet'
    currentExitTime: Timestamp | null;
  }
  ```

### 3.2. Collection: `active-hall-passes`
* **Document ID:** Teacher Email (e.g., `teacher@hhs.co.za`)
* **Purpose:** High-efficiency, low-write collection to track real-time venue exits (Max 2 students per teacher).
* **Fields:**
  ```typescript
  {
    teacherEmail: string;
    activeStudents: Array<{
      adminNo: string;        // 5-digit admin string
      reason: 'toilet' | 'front-office' | 'grade-controller' | 'other teacher' | 'other reason';
      leaveTime: Timestamp;
    }>;
  }
  ```

### 3.3. Collection: `history-hall-pass`
* **Document ID:** Auto-generated Firestore Unique Key
* **Purpose:** Immutable audit log of all completed and auto-swept hall pass movements.
* **Fields:**
  ```typescript
  {
    teacherEmail: string;
    adminNo: string;
    reason: string;
    leaveTime: Timestamp;
    returnedOn: Timestamp;
    durationMinutes: number;
    autoReturned: boolean;        // true if closed during daily sweep
    signedOffByTeacher: boolean;  // false if closed during daily sweep
    notes?: string;
  }
  ```

---

## 4. Completed Features
1. **Authentication:**
   * Microsoft SSO (`signInWithPopup` via `OAuthProvider`) and Email/Password fallbacks.
   * Modals auto-focus on load for unauthenticated users.
2. **Student Roster & Card Views:**
   * Display student avatar, full name, 5-digit admin number, grade, and class.
   * Real-time grid rendering with automated time-elapsed calculation (`isOut` status and elapsed minute counter).
3. **Core Pass Logic Rules:**
   * Valid reasons defined: `'toilet'`, `'front-office'`, `'grade-controller'`, `'other teacher'`, `'other reason'`.
   * Enforced venue limit: Max 2 active passes per teacher simultaneously.
   * Atomic batched updates on return: removes student from `active-hall-passes` and creates a document in `history-hall-pass`.

---

## 5. Remaining Implementation Tasks (Optimized Execution Order)

> **Context Optimization Note for Claude AI:** Execute tasks in this exact grouped sequence to prevent context overhead and duplicate code re-reads across sessions.

### Phase 1: Overdue Alerts & Student Card Badging
* **Objective:** Flag overdue students visually after 30 minutes of absence.
* **Task 1.1:** Update `renderStudentCard()` in `js/render.js` to compare `currentExitTime` or `activeStudents.leaveTime` against current time.
  * If $\ge 30$ minutes: apply class `.status-overdue` and display animated alert badge (`⚠️ OVERDUE: [reason] ([X]m)`).
  * If $< 30$ minutes: display standard badge (`🚶 Out: [reason] ([X]m)`).
* **Task 1.2:** Wire an automatic 60-second UI refresh timer (`setInterval`) in `app.js` to update overdue durations dynamically without triggering database reads.

### Phase 2: Role Access Guard & Authorization Rules
* **Objective:** Restrict dashboard access to Authorized Staff, Grade Controllers, and Admins while explicitly denying SLT.
* **Task 2.1:** Implement `canAccessNonReturnsDashboard()` in `auth-service.js`.
  * **Allowed Roles/Users:** `admin`, `grade-controller`, and specific user email whitelist.
  * **Explicit Deny:** `slt` role.
* **Task 2.2:** Add navigation guard to suppress or hide Non-Returns Dashboard tab/menu for unauthorized users.

### Phase 3: Non-Returns Dashboard & Lazy Auto-Sweep Logic
* **Objective:** Build real-time checking view and process unreturned passes from previous days.
* **Task 3.1:** Implement `getActivePassesWithAutoSweep()` in `non-returns-service.js`.
  * Query `active-hall-passes` collection.
  * Compare `leaveTime.toDate().toDateString()` with current day (`new Date().toDateString()`).
  * If `leaveTime` is from a prior day: batch update to move entry to `history-hall-pass` with `autoReturned: true` and `signedOffByTeacher: false`, then purge from active array.
* **Task 3.2:** Construct Non-Returns Dashboard UI Component in `js/dashboard.js`.
  * Display unified table/grid of active non-returns.
  * Highlight overdue items ($\ge 30$ mins) in red.
  * Provide action buttons for Admins/Grade Controllers to "Force Return" stuck passes manually.

---

## 6. Protocols for Error Handling & Anomalies

To prevent corrupted records or UI lockout, adhere to the following protocol rules:

### A. Exceeding Venue Limit (3rd Exit Attempt)
* **Anomaly:** A teacher attempts to issue a 3rd pass while 2 active passes exist in `active-hall-passes/{teacherEmail}`.
* **Handling:** Intercept before Firestore call. Display an inline alert modal: *"Venue Limit Reached: Maximum of 2 students allowed out simultaneously. Please log a returning student first."* Block the network transaction.

### B. Missing or Malformed 5-Digit Admin Numbers
* **Anomaly:** Admin number is submitted with less than 5 digits or containing non-numeric characters.
* **Handling:** Force string formatting using `String(adminNo).padStart(5, '0')`. Validate against regex `/^\d{5}$/` prior to querying Firestore. Reject invalid formats with UI validation error messages.

### C. Orphaned Active Passes (Cross-Day / End-of-Day)
* **Anomaly:** Student left class at 14:00 today but was never signed back in. Next morning at 07:30, they still appear in `active-hall-passes`.
* **Handling:** The **Lazy Auto-Sweep** triggers automatically on the first dashboard fetch of the new day, clearing stale items via `writeBatch` without requiring cron/cloud functions.

### D. Firestore Permission & Connectivity Failures
* **Anomaly:** Network drop or unauthorized Firestore read/write attempt.
* **Handling:** Wrap all Firestore calls in `try/catch` blocks. On error, execute UI toast message: *"Network/Permission Error: Unable to complete operation."* Revert optimistic UI updates.

---

## 7. Direct Instructions for AI Assistant (Claude Handover)

1. **Context Efficiency:** Read this document carefully. Implement tasks strictly in the order detailed in **Section 5 (Phase 1 → Phase 2 → Phase 3)**.
2. **File Structure Maintenance:** Keep code modular. Do not merge separate module files into a single monolithic file unless explicitly requested.
3. **Write Strategy Adherence:** Ensure all history logging actions use `writeBatch` to keep Firestore write counts to a absolute minimum (1 batch write per return/sweep event).