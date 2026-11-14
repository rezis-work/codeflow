export function Form() {
  async function saveDraft() {
    'use server';
    return { saved: true };
  }
  return saveDraft;
}
