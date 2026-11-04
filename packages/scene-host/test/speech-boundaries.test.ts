import {expect,it} from 'vitest';
import {speechPauseWindows} from '../src/recording/speech-boundaries';
it('waits for the next real word timestamp and uses Unicode positions without inventing a pause',()=>{
 const text='鱼🐟来了，接着读信。';
 expect(speechPauseWindows(text,[0,100,200,300,400])).toEqual([]);
 expect(speechPauseWindows(text,[0,100,200,300,400,500,600,700,800,900])).toEqual([{fromMs:410,toMs:490,firstUnreadChar:5}]);
 expect(speechPauseWindows(text,[0,100,200,300,400,400,500,600,700,800])).toEqual([]);
 expect(speechPauseWindows(text,[0,100,90])).toEqual([]);
});
