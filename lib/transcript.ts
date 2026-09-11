export interface RecognitionSegment {
  0: { transcript: string };
  isFinal: boolean;
}

export const collectRecognitionUpdate = (
  results: ArrayLike<RecognitionSegment>,
  resultIndex: number,
  finalized: Set<number>,
) => {
  let finalText = '';
  let interimText = '';
  for (let index = resultIndex; index < results.length; index += 1) {
    const segment = results[index];
    if (!segment) continue;
    const text = segment[0]?.transcript ?? '';
    if (segment.isFinal) {
      if (!finalized.has(index)) {
        finalized.add(index);
        finalText += text;
      }
    } else {
      interimText += text;
    }
  }
  return { finalText, interimText };
};
