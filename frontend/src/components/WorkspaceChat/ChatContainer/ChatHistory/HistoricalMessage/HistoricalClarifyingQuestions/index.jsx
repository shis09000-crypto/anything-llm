import SurveyBody from "../../ClarifyingQuestion/SurveyBody";

export default function HistoricalClarifyingQuestions({ surveys = [] }) {
  if (!Array.isArray(surveys) || surveys.length === 0) return null;

  return (
    <div className="flex flex-col gap-y-2 mb-3">
      {surveys.map((survey, i) => (
        <SurveyCard key={i} survey={survey} />
      ))}
    </div>
  );
}

function SurveyCard({ survey }) {
  const questions = Array.isArray(survey?.questions) ? survey.questions : [];
  const result = survey?.result || {};

  if (questions.length === 0) return null;

  return (
    <div className="border border-solid border-zinc-700 light:border-zinc-300 bg-transparent p-[18px] flex flex-col gap-[18px] rounded-lg">
      <SurveyBody questions={questions} result={result} />
    </div>
  );
}
