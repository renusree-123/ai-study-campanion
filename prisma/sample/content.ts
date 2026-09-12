/**
 * Seed learning material. Two documents in different domains so the demo can
 * show project isolation: a question answerable from one must not be
 * answerable from the other.
 */

export const SPACED_REPETITION_DOC = {
  filename: "Learning-Science-Handbook.pdf",
  title: "Learning Science Handbook",
  sections: [
    {
      heading: "1. The Forgetting Curve",
      paragraphs: [
        "Hermann Ebbinghaus demonstrated in 1885 that newly learned information decays rapidly and predictably. Testing himself on nonsense syllables, he found that without review roughly 60 percent of new material is lost within one hour, and close to 75 percent within six days. The shape of this decline is called the forgetting curve.",
        "The critical property of the forgetting curve is that it is not fixed. Each successful review flattens the curve, meaning the same material is forgotten more slowly after each retrieval. This flattening is the mechanism that all spacing strategies exploit. A learner who reviews material four times over two weeks retains substantially more at one month than a learner who studied the same total minutes in a single session.",
        "Forgetting is therefore not purely a failure of memory. Some decay between reviews is necessary: retrieval that requires effort produces stronger consolidation than retrieval that is trivially easy.",
      ],
    },
    {
      heading: "2. Spaced Repetition",
      paragraphs: [
        "Spaced repetition schedules reviews at expanding intervals rather than at a fixed cadence. A typical sequence reviews an item one day after first learning it, then three days later, then a week, then a month. Each interval is chosen to fall shortly before the point at which the learner would otherwise forget the item.",
        "The spacing effect is one of the most reliably replicated findings in learning research. Distributing the same total study time across multiple sessions produces markedly better long-term retention than massing it into one session, even though massed practice feels more productive at the time. This mismatch between how well learning feels and how well it works is the central practical difficulty of studying.",
        "Modern implementations adjust intervals per item based on recall difficulty. The SM-2 algorithm, used by many flashcard systems, multiplies the previous interval by an ease factor that rises after easy recalls and falls after difficult ones, so hard items return more often and easy items drift further apart.",
      ],
    },
    {
      heading: "3. Retrieval Practice",
      paragraphs: [
        "Retrieval practice means recalling information from memory rather than re-reading it. The act of retrieval is itself a learning event: it strengthens the memory trace more than additional exposure to the same material does. This is known as the testing effect.",
        "In a well-known 2006 study, Roediger and Karpicke had students study prose passages and then either restudy them or take a recall test. Students who restudied performed better on an immediate test, but after one week the students who had been tested retained substantially more. Re-reading produces confidence; retrieval produces durable memory.",
        "Retrieval is most effective when it is effortful but successful. Cues that make recall too easy provide little benefit, while cues that make it impossible produce frustration and no consolidation. Free recall is generally stronger than recognition, which is why open-ended questions test understanding more thoroughly than multiple choice.",
      ],
    },
    {
      heading: "4. Interleaving",
      paragraphs: [
        "Interleaving mixes different problem types or topics within a single study session, rather than practising one type to mastery before moving on. Blocked practice, where all problems of one kind are grouped together, produces faster improvement during the session but weaker performance on a later mixed test.",
        "The reason is that interleaving forces the learner to first identify which approach applies, a discrimination step that blocked practice removes entirely. When every problem on a page uses the same method, the learner practises executing the method but never practises choosing it. On a real assessment, choosing is half the task.",
        "Interleaving reliably feels worse than blocking. Learners rate interleaved sessions as less effective even when they measurably outperform blocked learners afterwards. Instructors should expect this objection and address it explicitly.",
      ],
    },
    {
      heading: "5. Elaboration and Self-Explanation",
      paragraphs: [
        "Elaboration means connecting new information to what is already known: asking why a fact is true, how it relates to another idea, and where it would apply. Elaborative interrogation, in which the learner repeatedly asks why of each new statement, consistently outperforms passive review.",
        "Self-explanation extends this to the learner's own reasoning. Learners who explain each step of a worked example to themselves, in their own words, transfer their knowledge to novel problems more successfully than learners who simply study the same examples.",
        "Both techniques work by increasing the number of retrieval routes to a memory. A fact linked to five other ideas can be reached through any of them; an isolated fact has only one path and is lost when that path fails.",
      ],
    },
    {
      heading: "6. Metacognition and Calibration",
      paragraphs: [
        "Calibration is the match between how well a learner believes they know something and how well they actually know it. Poorly calibrated learners stop studying too early because fluency during re-reading is mistaken for mastery.",
        "The most practical calibration tool is a low-stakes self-test taken before the learner believes they are ready. The gap between predicted and actual performance is usually large and always instructive.",
        "Judgements of learning made immediately after study are systematically inflated. The same judgement made after a delay is far more accurate, because the easy fluency of recent exposure has worn off.",
      ],
    },
    {
      heading: "7. Applying the Techniques Together",
      paragraphs: [
        "These techniques compound. A well-designed study plan spaces reviews across days, makes each review a retrieval attempt rather than a re-reading, interleaves related topics within a session, and requires the learner to explain answers rather than recognise them.",
        "A practical weekly structure: a short retrieval session daily covering material from one day, three days, and one week ago; a longer interleaved session twice a week mixing topics; and a self-test at the end of each week with predictions recorded beforehand so calibration can be checked.",
        "The common failure mode is substituting volume for structure. Doubling study hours while keeping the same passive re-reading approach produces far less improvement than restructuring existing hours around retrieval and spacing.",
      ],
    },
  ],
};

export const CLIMATE_DOC = {
  filename: "Introduction-to-Climate-Systems.pdf",
  title: "Introduction to Climate Systems",
  sections: [
    {
      heading: "1. Radiative Balance",
      paragraphs: [
        "Earth's temperature is set by the balance between incoming shortwave solar radiation and outgoing longwave infrared radiation. Averaged over the planet, roughly 340 watts per square metre arrive at the top of the atmosphere. About 30 percent is reflected directly back to space by clouds, aerosols and bright surfaces, a fraction known as the planetary albedo.",
        "The remaining energy is absorbed and must eventually be re-emitted as infrared radiation. When the outgoing flux equals the absorbed flux, the system is in radiative equilibrium and temperature is stable. Any process that reduces outgoing radiation without reducing incoming radiation creates a positive imbalance, and the surface warms until emission rises enough to restore balance.",
      ],
    },
    {
      heading: "2. The Greenhouse Effect",
      paragraphs: [
        "Greenhouse gases are transparent to incoming shortwave radiation but absorb outgoing longwave radiation, re-emitting a portion of it downward. This raises the effective emission altitude, which cools the emitting layer and therefore reduces radiation to space until the surface warms to compensate.",
        "Water vapour is the most abundant greenhouse gas, but its concentration is controlled by temperature rather than by emissions, so it acts as a feedback rather than a forcing. Carbon dioxide, methane and nitrous oxide are long-lived and externally controlled, which makes them the drivers of change.",
        "Without any greenhouse effect Earth's mean surface temperature would be roughly minus 18 degrees Celsius rather than the observed 15 degrees Celsius. The effect is not an anomaly; the question is its magnitude.",
      ],
    },
    {
      heading: "3. Feedback Mechanisms",
      paragraphs: [
        "A feedback amplifies or damps an initial forcing. The water vapour feedback is the largest positive one: warmer air holds more moisture, and moisture is itself a greenhouse gas, so warming begets warming. The ice-albedo feedback is also positive, as retreating ice exposes darker ocean and land that absorb more radiation.",
        "The dominant negative feedback is the Planck response: a warmer surface radiates more energy, following the fourth power of absolute temperature. This is what stabilises the system and prevents runaway warming.",
        "Cloud feedbacks remain the largest source of uncertainty. Low clouds are reflective and cool the surface; high thin clouds trap outgoing radiation and warm it. How their balance shifts with warming determines much of the spread across climate models.",
      ],
    },
    {
      heading: "4. Ocean Heat Uptake",
      paragraphs: [
        "More than ninety percent of the excess energy trapped by greenhouse gases has been absorbed by the ocean. Water's high heat capacity means this absorption produces only a small temperature change while removing a large amount of energy from the atmosphere.",
        "This uptake delays surface warming. Even if concentrations were held fixed today, the surface would continue to warm for decades as the deep ocean equilibrates. This committed warming is a direct consequence of thermal inertia.",
        "Ocean heat content is a more reliable indicator of planetary energy imbalance than surface temperature, because it is far less affected by year-to-year variability such as El Nino.",
      ],
    },
  ],
};
