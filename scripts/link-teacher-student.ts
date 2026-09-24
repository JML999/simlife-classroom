/** Link an existing teacher sign-in to an existing Period 1 student account.
 * Usage: tsx scripts/link-teacher-student.ts teacher@example.org student@example.org
 * This does not merge users or move any balances or submissions.
 */
import "../server/env.js";
import { initSchema, one, run, nowIso } from "../server/db.js";

const [teacherEmail, studentEmail] = process.argv.slice(2).map((value) => value.trim().toLowerCase());
if (!teacherEmail || !studentEmail) throw new Error("Pass the teacher and student email addresses.");
await initSchema();
const teacher = await one<{ id: string; name: string; role: string }>(
  `SELECT id, name, role FROM users WHERE LOWER(email) = ?`, [teacherEmail],
);
const student = await one<{ id: string; name: string; role: string; class_id: string }>(
  `SELECT id, name, role, class_id FROM users WHERE LOWER(email) = ?`, [studentEmail],
);
if (teacher?.role !== "teacher") throw new Error("The first email must belong to a teacher account.");
if (student?.role !== "student" || student.class_id !== "demo-class-1") {
  throw new Error("The second email must belong to a Period 1 student account.");
}
await run(
  `INSERT INTO teacher_student_views (teacher_id, student_id, created_at) VALUES (?, ?, ?)
   ON CONFLICT (teacher_id) DO UPDATE SET student_id = excluded.student_id`,
  [teacher.id, student.id, nowIso()],
);
console.log(`Linked ${teacher.name} (${teacher.id}) to ${student.name} (${student.id}) for the Student view.`);
