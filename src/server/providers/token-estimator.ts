export interface TokenEstimator {
  estimate(text: string): number;
}
export const conservativeTokenEstimator: TokenEstimator = {
  estimate(text) {
    return Math.ceil(text.length / 3.5);
  },
};
