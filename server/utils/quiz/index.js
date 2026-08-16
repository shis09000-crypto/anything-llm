const {
  abandonQuiz,
  deleteFavoriteQuestion,
  dismissQuizWrongQuestions,
  generateQuiz,
  quizStatus,
  saveFavoriteQuestion,
  saveQuizProgress,
  saveQuizWrongQuestions,
  submitQuiz,
  submitQuizStream,
  quizHistory,
} = require("./responsesClient");

module.exports = {
  generateQuiz,
  quizStatus,
  submitQuiz,
  submitQuizStream,
  saveQuizProgress,
  abandonQuiz,
  dismissQuizWrongQuestions,
  saveQuizWrongQuestions,
  saveFavoriteQuestion,
  deleteFavoriteQuestion,
  quizHistory,
};
